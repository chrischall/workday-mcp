// WorkdayClient is the thin, tool-facing API over a WorkdayTransport.
//
// It owns:
//   - deferred config (WORKDAY_TENANT required, WORKDAY_HOST defaulted) so the
//     server still boots for the host's install-time tools/list probe; the
//     config error surfaces on the first tool call.
//   - one fetch primitive, `fetchJson(path)`, that round-trips a Workday
//     `*.htmld` data endpoint through the bridge and parses the JSON body.
//   - error mapping: non-2xx, the SSO/sign-in bounce (expired session), and
//     non-JSON bodies all become typed, actionable errors here so tool authors
//     never handle them.
import {
  formatApiError,
  mapWithConcurrency,
  messageOf,
  readEnvVar,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  WorkdayTransport,
} from './transport.js';
import {
  parseTask,
  parseApps,
  type WorkdayTask,
  type WorkdayApp,
  type WorkdayReference,
  type WorkdayOrgChart,
} from './parse.js';
import { redactTree } from './redact.js';

const DEFAULT_HOST = 'wd5.myworkday.com';

// Re-export the shared "go authenticate" error so tool code (and the
// healthcheck's `instanceof` classifier) keeps importing it from here. The
// Workday-specific SSO re-sign-in copy now lives in the healthcheck's
// `classifyThrown` hint rather than in the error message.
export { SessionNotAuthenticatedError };

export class WorkdayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdayConfigError';
  }
}

export interface WorkdayClientOptions {
  transport: WorkdayTransport;
  /** Overrides for env config — primarily for tests. */
  tenant?: string;
  host?: string;
}

export interface CrawlOptions {
  /** How many levels of child cards to follow. 0 fetches only the given page. */
  depth?: number;
  /** Hard cap on child fetches, so a hub with 40 cards cannot fan out
   *  unbounded through the user's browser. */
  maxCards?: number;
  /** Child fetches to run at once. */
  concurrency?: number;
}

/** One child card pulled in by a crawl. */
export interface WorkdayCrawledCard {
  uri: string;
  label: string;
  task: WorkdayTask;
}

/** A page plus the child cards it delegates its real content to. */
export interface WorkdayCrawlResult extends WorkdayTask {
  cards: WorkdayCrawledCard[];
  /** Child uris left unfetched because `maxCards` ran out. */
  skipped?: string[];
  /** Child cards that failed, so a partial crawl is still legible. */
  errors?: Array<{ uri: string; error: string }>;
}

const DEFAULT_CRAWL_DEPTH = 1;
const DEFAULT_MAX_CARDS = 12;
const DEFAULT_CRAWL_CONCURRENCY = 4;

/** Strip a leading anti-CSRF/guard prefix (anything before the first `{`)
 *  from a Workday JSON body. Live tenants currently emit clean JSON, but
 *  classic Workday endpoints have historically guarded it. */
export function stripJsonGuard(body: string): string {
  const start = body.indexOf('{');
  return start > 0 ? body.slice(start) : body;
}

/** Remove string literals and comments so an operation-keyword scan cannot be
 *  fooled by the word `mutation` appearing inside either.
 *
 *  ORDER IS LOAD-BEARING. Stripping comments first lets a `#` *inside a string*
 *  blank the rest of the line — so `query Q { f(a: "#") } mutation Evil { … }`
 *  would have had its `mutation` erased before the scan ever saw it, while the
 *  ORIGINAL document (still the thing POSTed) executes the write. Strings are
 *  therefore consumed first — block strings, then quoted ones — and only what
 *  survives can introduce a comment. */
function stripGraphqlNoise(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

/** Throw unless `query` declares only read operations. workday-mcp is
 *  read-only, and a GraphQL passthrough is the one place a caller could
 *  otherwise hand Workday a write. */
export function assertReadOnlyGraphql(query: string): void {
  const cleaned = stripGraphqlNoise(query);
  // `\b` after the keyword is what stops a FIELD named `mutationLog` from
  // reading as an operation; the lookahead requires a name, `(` or `{` next,
  // which is the only thing that can legally follow an operation keyword.
  const writeOp = /(^|[\s})])(mutation|subscription)\b\s*(?=[\w({])/i.exec(cleaned);
  if (writeOp) {
    throw new Error(
      `workday-mcp is read-only: the GraphQL document declares a \`${writeOp[2].toLowerCase()}\` ` +
        'operation. Only `query` operations are allowed.'
    );
  }
}

/** Match an app by label: case-insensitive substring, or a RegExp. Returns the
 *  first match in menu order — Workday's own relevance ordering. */
function matchApp(apps: WorkdayApp[], match: string | RegExp): WorkdayApp | null {
  const test =
    typeof match === 'string'
      ? (label: string) => label.toLowerCase().includes(match.toLowerCase())
      : (label: string) => match.test(label);
  return apps.find((a) => test(a.label)) ?? null;
}

export class WorkdayClient {
  private readonly transport: WorkdayTransport;
  readonly host: string;
  private readonly tenantValue: string | undefined;
  private readonly configError: WorkdayConfigError | undefined;
  /** Workday's CSRF token for POSTs. Never returned to a caller. */
  private sessionSecureToken: string | undefined;
  /** Learned-once worker-profile uri prefix for this tenant. */
  private profilePrefix: string | undefined;

  constructor(opts: WorkdayClientOptions) {
    this.transport = opts.transport;
    this.host = opts.host ?? readEnvVar('WORKDAY_HOST') ?? DEFAULT_HOST;
    const tenant = opts.tenant ?? readEnvVar('WORKDAY_TENANT');
    if (!tenant) {
      this.configError = new WorkdayConfigError(
        'WORKDAY_TENANT is not set. Set it to your Workday tenant slug — the path segment ' +
          'after the host, e.g. for https://wd5.myworkday.com/acme it is `acme`. ' +
          '(Optionally set WORKDAY_HOST if your data center host is not wd5.myworkday.com.)'
      );
    }
    this.tenantValue = tenant;
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  /** Throws the deferred config error if tenant config is missing. */
  get tenant(): string {
    if (this.configError) throw this.configError;
    return this.tenantValue as string;
  }

  /** The deferred config error message, or null when config is present.
   *  Lets the healthcheck report missing config without throwing. */
  get configErrorMessage(): string | null {
    return this.configError ? this.configError.message : null;
  }

  bridgeStatus(): BridgeStatus {
    return this.transport.status();
  }

  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.transport.runProbe(fetchFn, probePath);
  }

  /**
   * Normalize a caller-supplied path to a tenant-scoped Workday data endpoint:
   *   - trim a trailing `#fragment` (browser address-bar URLs carry them)
   *   - prefix `/{tenant}/` when the caller passes a bare suffix
   *   - convert a copied SPA URL (`/{tenant}/d/inst/...`) to its JSON data
   *     endpoint (`/{tenant}/inst/...`) by dropping the `/d/` segment
   */
  resolvePath(path: string): string {
    let p = path.trim();
    const hash = p.indexOf('#');
    if (hash >= 0) p = p.slice(0, hash);
    // A bare Workday task id (e.g. `2998$43525`) resolves to the constructable
    // task data endpoint — lets callers pass an id from workday_get_apps or a
    // prior result's references without knowing the URL shape.
    if (/^\d+\$[A-Za-z0-9_-]+$/.test(p)) return `/${this.tenant}/task/${p}.htmld`;
    if (!p.startsWith('/')) p = `/${this.tenant}/${p}`;
    p = p.replace(`/${this.tenant}/d/`, `/${this.tenant}/`);
    // Workday hands out most drill-in uris WITHOUT the extension, and every
    // one of those 404s until `.htmld` is appended (verified live against a
    // production tenant). Paths that already carry an extension are left be.
    const [pathPart, query] = p.split('?', 2);
    if (!/\.[a-z0-9]+$/i.test(pathPart)) {
      p = query ? `${pathPart}.htmld?${query}` : `${pathPart}.htmld`;
    }
    return p;
  }

  /**
   * GET a Workday `*.htmld` data endpoint and return the parsed JSON object.
   * Throws on non-2xx, an SSO/sign-in bounce, or a non-JSON body.
   */
  async fetchJson(path: string): Promise<unknown> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    const stripped = stripJsonGuard(result.body);
    try {
      const json = JSON.parse(stripped);
      this.rememberSessionToken(json);
      return json;
    } catch (e) {
      // A 200 that isn't JSON is almost always the SPA shell HTML or an SSO
      // page — point the user at the data-endpoint vs SPA-route distinction.
      throw new Error(
        `Workday GET ${path} returned a non-JSON body (${(e as Error).message}). ` +
          `This usually means the path is a SPA route (under /d/) or an SSO page rather than a ` +
          `data endpoint. Use the JSON data path (e.g. /${this.tenant}/inst/.../cacheable-task/<id>.htmld).`
      );
    }
  }

  /** GET a path and return the raw body string, applying the non-2xx and
   *  signed-out guards. Used by the healthcheck probe (which wants the body
   *  length, not parsed JSON). */
  async fetchRaw(path: string): Promise<string> {
    const result = await this.transport.fetch({ path, method: 'GET' });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    return result.body;
  }

  /** Fetch a Workday data endpoint and parse it into a flat, secret-free task. */
  async getTask(path: string): Promise<WorkdayTask> {
    const resolved = this.resolvePath(path);
    const json = await this.fetchJson(resolved);
    return parseTask(json);
  }

  /** List the user's Workday apps (label + launchable task id). */
  async getApps(): Promise<WorkdayApp[]> {
    const json = await this.fetchJson(
      `/${this.tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true`
    );
    return parseApps(json);
  }

  /**
   * Fetch a page and follow it down to the child cards that carry its real
   * content.
   *
   * This is the single most important read path for anything hub-shaped —
   * which is nearly every Workday app a manager opens. A container task
   * (`My Team`, `Benefits and Pay`) returns a near-empty shell whose child
   * `card/all/<cardId>/<pageCtx>.htmld` endpoints hold the data, and that
   * `pageCtx` token is NOT constructable: it exists only inside the parent's
   * response. So the only way to read a hub is to load it and follow.
   *
   * Bounded on three axes — `depth`, `maxCards`, and a visited set — because
   * every hop is a real fetch through the user's own browser tab. What the
   * budget cut is reported in `skipped`, and a child that fails is recorded in
   * `errors` rather than sinking the whole crawl: a partial read of a hub is
   * far more useful than an exception.
   */
  async crawl(path: string, opts: CrawlOptions = {}): Promise<WorkdayCrawlResult> {
    const depth = opts.depth ?? DEFAULT_CRAWL_DEPTH;
    const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS;
    const concurrency = opts.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;

    const rootPath = this.resolvePath(path);
    const root = await this.getTask(rootPath);
    const result: WorkdayCrawlResult = { ...root, cards: [] };

    const visited = new Set<string>([rootPath]);
    const skipped: string[] = [];
    const errors: Array<{ uri: string; error: string }> = [];
    let frontier: WorkdayReference[] = root.childCards;

    for (let level = 0; level < depth; level++) {
      const batch: WorkdayReference[] = [];
      for (const ref of frontier) {
        const uri = ref.uri;
        if (!uri || visited.has(uri)) continue;
        visited.add(uri);
        if (result.cards.length + batch.length >= maxCards) {
          skipped.push(uri);
          continue;
        }
        batch.push(ref);
      }
      if (!batch.length) break;

      const fetched = await mapWithConcurrency(batch, concurrency, async (ref) => {
        try {
          return { ref, task: await this.getTask(ref.uri as string) };
        } catch (e) {
          errors.push({ uri: ref.uri as string, error: messageOf(e) });
          return null;
        }
      });

      const next: WorkdayReference[] = [];
      for (const hit of fetched) {
        if (!hit) continue;
        result.cards.push({
          uri: hit.ref.uri as string,
          label: hit.ref.label || hit.task.title || '',
          task: hit.task,
        });
        next.push(...hit.task.childCards);
      }
      frontier = next;
    }

    if (skipped.length) result.skipped = skipped;
    if (errors.length) result.errors = errors;
    return result;
  }

  /**
   * Find one of the user's apps by label. Accepts a substring (matched
   * case-insensitively) or a RegExp, and returns the FIRST app in menu order
   * that matches — menu order being Workday's own relevance ordering.
   *
   * This is what keeps the typed tools (`workday_get_team`, `workday_get_pay`,
   * …) tenant-agnostic: they resolve their entry point from the live app menu
   * at call time rather than carrying a task id captured from one tenant, which
   * would be meaningless on anyone else's.
   */
  async resolveApp(match: string | RegExp): Promise<WorkdayApp | null> {
    return matchApp(await this.getApps(), match);
  }

  /**
   * Resolve an app by label and crawl it in one step — the backbone every
   * typed manager tool is built on. Throws an error naming the apps that DO
   * exist when nothing matches, so a mismatch is self-diagnosing.
   */
  async openApp(match: string | RegExp, opts: CrawlOptions = {}): Promise<WorkdayCrawlResult> {
    // Fetch the menu ONCE and match against it — the error path needs the very
    // same list to name the alternatives.
    const apps = await this.getApps();
    const app = matchApp(apps, match);
    if (!app || !app.taskId) {
      const available = apps.map((a) => a.label);
      throw new Error(
        `No Workday app matching ${match instanceof RegExp ? match.source : `"${match}"`}` +
          `${app && !app.taskId ? ' has a launchable task id' : ' is on your home screen'}. ` +
          `Available apps: ${available.join(', ') || '(none)'}. ` +
          'Use `workday_get_apps` to see them, or open the page in your browser and pass its ' +
          'URL to `workday_get_task`.'
      );
    }
    return this.crawl(app.taskId, opts);
  }

  /**
   * Read the org chart — the reporting chain around the signed-in user.
   *
   * Resolved through the app menu by LABEL rather than a captured task id, so
   * it works on any tenant.
   */
  async getOrgChart(): Promise<WorkdayOrgChart> {
    const page = await this.openApp(/org chart|organization chart/i, { depth: 0 });
    if (!page.org) {
      throw new Error(
        'The Org Chart app did not return a hierarchy. Open it in your browser and pass ' +
          'its URL to `workday_get_task` to see what it returns.'
      );
    }
    return page.org;
  }

  /**
   * The tenant's worker-profile uri prefix (e.g. `/{tenant}/inst/1$715/`).
   *
   * Workday's profile endpoint embeds a task-context id that differs per
   * tenant, so it cannot be hardcoded — but the org chart hands out concrete
   * profile uris for every person it shows, and every one of them shares that
   * prefix. Learning it from live data once keeps `getWorker` tenant-agnostic.
   */
  private async workerProfilePrefix(): Promise<string> {
    if (this.profilePrefix) return this.profilePrefix;
    const org = await this.getOrgChart().catch(() => null);
    const withUri = [...(org?.ancestors ?? []), ...(org?.nodes ?? [])].find(
      (n) => n.profileUri && n.instanceId
    );
    if (!withUri?.profileUri || !withUri.instanceId) {
      throw new Error(
        'Could not learn this tenant\'s worker profile uri from the org chart. ' +
          'Pass a full profile uri instead of a bare worker id — take one from an org chart ' +
          'node\'s `profileUri`, a reference\'s `uri`, or your browser\'s address bar.'
      );
    }
    // Strip the instance id off a known-good profile uri to leave the prefix.
    const idx = withUri.profileUri.lastIndexOf(withUri.instanceId);
    if (idx < 0) {
      throw new Error(
        'The org chart returned a profile uri in an unexpected shape; pass a full profile ' +
          'uri to read a worker.'
      );
    }
    this.profilePrefix = withUri.profileUri.slice(0, idx);
    return this.profilePrefix;
  }

  /**
   * Read a worker's profile — the manager's main entry point into a report's
   * data. Accepts either a full profile uri (from an org chart node or any
   * reference) or a bare worker instance id like `247$42`.
   *
   * The returned page's `profile.sections[].tasks[]` is a catalog of every
   * drill-in Workday offers for that person (Job Details, Compensation,
   * Performance Reviews, Time Off, …), each already fetchable.
   */
  async getWorker(idOrUri: string): Promise<WorkdayTask> {
    const trimmed = idOrUri.trim();
    if (trimmed.startsWith('/') || trimmed.includes('.htmld')) {
      return this.getTask(trimmed);
    }
    const prefix = await this.workerProfilePrefix();
    return this.getTask(`${prefix}${trimmed}.htmld`);
  }

  /**
   * Read the signed-in user's OWN worker profile.
   *
   * Resolved via the org chart's `workerIid` rather than the envelope's
   * `currentUser.iid` — those are different identifiers, and only the worker
   * one addresses a profile.
   */
  async getMyProfile(): Promise<WorkdayTask> {
    const org = await this.getOrgChart();
    if (!org.workerId) {
      throw new Error(
        'The org chart did not identify your worker id. Open your own profile in Workday and ' +
          'pass its URL to `workday_get_worker`.'
      );
    }
    return this.getWorker(org.workerId);
  }

  /**
   * Read ONE named drill-in from a worker's profile, e.g. "Compensation" or
   * "Performance Reviews" — matched case-insensitively against the profile's
   * own task catalog, so the caller never needs the per-worker context id the
   * uri embeds. Lists the real options when nothing matches.
   */
  async getWorkerTask(
    idOrUri: string,
    taskLabel: string
  ): Promise<{ matched: string; section: string; uri: string; task: WorkdayTask }> {
    const profilePage = await this.getWorker(idOrUri);
    const sections = profilePage.profile?.sections ?? [];
    const wanted = taskLabel.trim().toLowerCase();
    for (const section of sections) {
      for (const task of section.tasks) {
        if (task.label.toLowerCase() === wanted || task.label.toLowerCase().includes(wanted)) {
          if (!task.uri) continue;
          return {
            matched: task.label,
            section: section.label,
            uri: task.uri,
            task: await this.getTask(task.uri),
          };
        }
      }
    }
    const available = sections
      .map((s) => `${s.label}: ${s.tasks.map((t) => t.label).join(', ')}`)
      .join(' | ');
    throw new Error(
      `No task matching "${taskLabel}" on this worker's profile. Available — ${available || '(none)'}`
    );
  }

  /**
   * GET a path and return the RAW parsed envelope with secrets redacted.
   *
   * The escape hatch for surfaces `parseTask` does not model yet. `parseTask`
   * is safe by construction (allowlist); this is the opposite shape, so it runs
   * the whole tree through {@link redactTree}'s denylist before returning.
   */
  async fetchRawJson(path: string): Promise<unknown> {
    const json = await this.fetchJson(this.resolvePath(path));
    return redactTree(json);
  }

  /**
   * POST a JSON body and return the parsed JSON response.
   *
   * Workday guards state-changing POSTs with the envelope's
   * `sessionSecureToken`. We hold that token privately (captured off any JSON
   * response we have already fetched — see `rememberSessionToken`) and send it
   * as a header; it is NEVER returned to a caller.
   */
  async postJson(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<unknown> {
    const result = await this.transport.fetch({
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.sessionSecureToken
          ? { 'X-Workday-Session-Secure-Token': this.sessionSecureToken }
          : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    this.throwIfNotOk(result, 'POST', path);
    this.throwIfSignedOut(result);
    try {
      return JSON.parse(stripJsonGuard(result.body));
    } catch (e) {
      throw new Error(
        `Workday POST ${path} returned a non-JSON body (${(e as Error).message}).`
      );
    }
  }

  /**
   * Run a GraphQL **query** against Workday's PEX surface.
   *
   * This is the only documented route to the Inbox / "My Tasks" and global
   * search — every guessed `.htmld` path for those 404s (see
   * docs/WORKDAY-API.md). Operations are not published, so the caller supplies
   * the document.
   *
   * The response is passed through {@link redactTree} before it is returned —
   * it is Workday's own payload, so it gets the same denylist as
   * `fetchRawJson`.
   *
   * READ-ONLY GUARD: the document is rejected if it declares a `mutation` or
   * `subscription` operation. The check runs on the document with comments and
   * string literals stripped, so neither a field named `mutationLog` nor the
   * word inside a string can smuggle one past — and, being a keyword check on
   * operation definitions, it fails closed.
   */
  async graphql(
    query: string,
    variables: Record<string, unknown> = {},
    operationName?: string
  ): Promise<unknown> {
    assertReadOnlyGraphql(query);
    const op = operationName ? `?operation=${encodeURIComponent(operationName)}` : '';
    await this.primeSessionToken();
    const response = await this.postJson(`/wday/pex/graphql/graphql${op}`, {
      query,
      variables,
      ...(operationName ? { operationName } : {}),
    });
    // Same contract as `fetchRawJson`: this hands back Workday's own payload,
    // so it gets the denylist. Returning it raw would have contradicted what
    // src/redact.ts, src/tools/raw.ts and CLAUDE.md all promise.
    return redactTree(response);
  }

  /** Ensure a session token has been captured before a POST that needs one.
   *  Cheap: the apps endpoint is small and already used for discovery. */
  private async primeSessionToken(): Promise<void> {
    if (this.sessionSecureToken) return;
    try {
      await this.fetchJson(`/${this.tenant}/quickaccess/fetch.htmld?shouldFetchUpcApps=true`);
    } catch {
      // Best effort — the POST may not need the token; let it speak for itself.
    }
  }

  /** Capture the envelope's session token for use as a POST CSRF header.
   *  Held in a private field and never returned by any method — the parser's
   *  allowlist keeps it out of tool output, and this keeps it out of ours. */
  private rememberSessionToken(json: unknown): void {
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const token = (json as Record<string, unknown>).sessionSecureToken;
      if (typeof token === 'string' && token) this.sessionSecureToken = token;
    }
  }

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    if (result.status === 401 || result.status === 403) {
      throw new SessionNotAuthenticatedError('Workday', this.host);
    }
    const collapsed = result.body.replace(/\s+/g, ' ').trim();
    throw new Error(
      formatApiError(result.status, method, path, collapsed, { service: 'Workday' })
    );
  }

  private throwIfSignedOut(result: FetchResult): void {
    // Two missing-session signals:
    //   1. The bridge fetch landed off the tenant host — an SSO redirect to
    //      Ping/Okta/Entra (the IdP lives on a different domain).
    //   2. The body is an HTML login/SAML page rather than the JSON widget
    //      tree (SAMLRequest / "Sign On" markers), short enough not to
    //      false-positive on a real data page that merely links to login.
    let offHost = false;
    try {
      offHost = new URL(result.url).host !== this.host;
    } catch {
      offHost = false;
    }
    const looksLikeSso =
      offHost ||
      (!result.body.trimStart().startsWith('{') &&
        /SAMLRequest|loginRedirectUrl|name=["']pingfederate|Sign On to|window\.location\s*=\s*["'][^"']*\/login/i.test(
          result.body
        ) &&
        result.body.length < 200_000);
    if (looksLikeSso) throw new SessionNotAuthenticatedError('Workday', this.host);
  }
}
