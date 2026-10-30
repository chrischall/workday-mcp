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
  detectEdgeBlock,
  EdgeBlockedError,
  formatApiError,
  mapWithConcurrency,
  messageOf,
  readEnvVar,
  requireEnvVar,
  SessionNotAuthenticatedError,
} from '@chrischall/mcp-utils';
import {
  graphqlOperationKinds,
  inspectGraphqlDocument,
  isReadOnlyGraphqlDocument,
  type GraphqlDocumentInfo,
} from '@chrischall/mcp-utils/graphql';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  WorkdayTransport,
} from './transport.js';
import { randomUUID } from 'node:crypto';
import {
  parseTask,
  parseApps,
  parseFormValues,
  parseQuestionnaire,
  parseWizardSections,
  hasSubmitBar,
  type WorkdayTask,
  type WorkdayApp,
  type WorkdayReference,
  type WorkdayOrgChart,
  type WorkdayFormValue,
  type WorkdayGrid,
  type WorkdayQuestionnaire,
  type WorkdayProfileSection,
} from './parse.js';
import { isSecretKey, redactTree } from './redact.js';

/** Redaction depth cap for the typed path — generous so it never cuts off a
 *  subtree that `parseTask`'s own depth-40 walks (from nested sub-roots) reach. */
const TYPED_REDACT_MAX_DEPTH = 256;

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

/**
 * Reduce a user-entered `WORKDAY_HOST` to a bare lowercase hostname.
 *
 * The value comes verbatim from env / the `.mcpb` install form, and natural
 * entries — `https://wd5.myworkday.com`, a copied address-bar URL with a path,
 * `WD5.myworkday.com`, a trailing slash — would otherwise break every call:
 * the scheme lands in the bridge subdomain, and the case/slash mismatch makes
 * the off-host check report every good response as an expired SSO session.
 * Blank or unset falls back to the default data-center host.
 */
export function normalizeHost(raw: string | undefined): string {
  let s = (raw ?? '').trim();
  if (!s) return DEFAULT_HOST;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/, 1)[0].replace(/\.+$/, '').toLowerCase();
  return s || DEFAULT_HOST;
}

/**
 * Parse `WORKDAY_WS_PORT`. Unset/blank → `undefined` (the bridge default);
 * anything but an integer in 1–65535 throws {@link WorkdayConfigError}, which
 * the entrypoint hands to the client so it surfaces on the deferred-config
 * path instead of reaching the transport as `NaN`.
 */
export function parsePort(raw: string | undefined): number | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new WorkdayConfigError(
      `WORKDAY_WS_PORT is set to "${s}", which is not a valid port. Set it to an integer ` +
        'between 1 and 65535, or unset it to use the default bridge port 37149.'
    );
  }
  return n;
}

export interface WorkdayClientOptions {
  transport: WorkdayTransport;
  /** Overrides for env config — primarily for tests. */
  tenant?: string;
  host?: string;
  /** A config error found by the entrypoint (e.g. an invalid
   *  `WORKDAY_WS_PORT`), surfaced on first use like a missing tenant. */
  configError?: WorkdayConfigError;
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

/** One person in a team roster. */
export interface WorkdayTeamMember {
  name: string;
  /** Worker instance id, accepted by every worker tool. */
  workerId?: string;
  profileUri?: string;
  /** The roster's other columns (associate id, position, location, …). */
  details: Record<string, string>;
}

/** A supervisory organization you manage, with its members. */
export interface WorkdayTeamOrg {
  name: string;
  id?: string;
  members: WorkdayTeamMember[];
  /** Present when Workday paged the roster: only `shown` of `total` came back. */
  incomplete?: { shown: number; total: number };
}

export interface WorkdayTeam {
  organizations: WorkdayTeamOrg[];
}

/** One performance review in a worker's history. */
export interface WorkdayReviewSummary {
  review: string;
  /** The grid it was listed under ("Completed", "In Progress", …). */
  status: string;
  periodStart?: string;
  periodEnd?: string;
  rating?: string;
  /** GET-able printable view of the review. */
  viewUri?: string;
}

export interface WorkdayReviewSection {
  name: string;
  values: WorkdayFormValue[];
  grids?: WorkdayGrid[];
}

export interface WorkdayReview {
  review: string;
  periodStart?: string;
  periodEnd?: string;
  rating?: string;
  /** The evaluation the printable view is showing, e.g. "Manager Evaluation: …". */
  heading?: string;
  sections: WorkdayReviewSection[];
}

export type FeedbackKind = 'received' | 'given' | 'requested';

/** The profile task each feedback kind lives under. */
const FEEDBACK_TASKS: Record<FeedbackKind, string> = {
  received: 'Feedback Received',
  given: 'Feedback Given',
  requested: 'Feedback Requested',
};

export interface WorkdayRequestForm extends WorkdayQuestionnaire {
  requestType: string;
}

/**
 * Workday's delivered "Create Request" task. Delivered (`2997$`) task ids are
 * Workday's own, not tenant configuration, so this addresses the same task on
 * every tenant — and a GET of it opens the request-type prompt without
 * creating anything.
 */
const CREATE_REQUEST_TASK = '2997$12683';

/** Workday's delivered "My Requests" report — a GET-able grid of the
 *  requests you created, with status. Delivered, like Create Request. */
const MY_REQUESTS_TASK = '3005$4617';

/** One item waiting in your Workday inbox ("My Tasks"). */
export interface WorkdayInboxItem {
  title: string;
  /** The business process it belongs to ("Performance Review", …). */
  type?: string;
  /** What you are asked to do ("Provide Employee Review Comments"). */
  task?: string;
  created?: string;
  effective?: string;
  starred?: boolean;
  /** GET-able page for the task — open it with `workday_get_task`. */
  uri?: string;
  /** GET-able "View Details" page for the business process. */
  detailsUri?: string;
}

export type InboxCategory = 'actions' | 'archive';

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

/** Throw unless `query` declares only read operations. workday-mcp is
 *  read-only, and a GraphQL passthrough is the one place a caller could
 *  otherwise hand Workday a write. */
export function assertReadOnlyGraphql(query: string): void {
  // mcp-utils' inspector (a real tokenizer + cursor parser, fleet-audit#1231)
  // reads the document once; whatever it cannot read is refused below.
  let info: GraphqlDocumentInfo | undefined;
  let unreadable: unknown;
  try {
    info = inspectGraphqlDocument(query);
  } catch (err) {
    unreadable = err;
  }
  const unterminated = unreadable !== undefined && /unterminated/.test(messageOf(unreadable));
  // A document that does not lex cannot be judged. Workday's own parser would
  // reject it as a syntax error, but refusing here keeps the guard fail-closed
  // rather than outsourcing the decision — an unterminated `"""` is exactly the
  // shape that makes a scanner disagree with a real lexer about where a
  // `mutation` lives.
  if (unterminated) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it contains an ' +
        'unterminated string literal. Fix the quoting and retry.'
    );
  }
  // The operation-kind decision is mcp-utils' (a real tokenizer + top-level
  // grammar). Keywords are compared case-insensitively: a capitalised
  // `Mutation` cannot parse anyway, and naming it as a write is the safe
  // reading. A type-system (SDL) word such as `extend` or `scalar` — or any
  // other top-level word — is refused as unverifiable: Workday executes
  // queries, not schema definitions.
  const kinds = graphqlOperationKinds(query).map((k) => k.toLowerCase());
  const write = kinds.find((k) => k === 'mutation' || k === 'subscription');
  if (write) {
    throw new Error(
      `workday-mcp is read-only: the GraphQL document declares a \`${write}\` ` +
        'operation. Only `query` operations are allowed.'
    );
  }
  const other = kinds.find((k) => k !== 'query' && k !== 'fragment');
  if (other) {
    throw new Error(
      `workday-mcp could not verify this GraphQL document is read-only: it contains a ` +
        `top-level \`${other}\` definition (a type-system definition or an unknown keyword), ` +
        'which is neither a query nor a fragment. ' +
        'Send only executable operations (`query` / `fragment`).'
    );
  }
  // Fail closed on anything else the shared check cannot vouch for: unbalanced
  // braces, a malformed definition head, or a document with no query at all.
  if (!isReadOnlyGraphqlDocument(query)) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it does not parse as ' +
        'one or more `query` operations (check the braces and the definition heads).'
    );
  }
  // A document the shared check accepts but the inspector cannot read is
  // refused too: its aliases cannot be listed, so the redaction guard below
  // could not vouch for it.
  if (!info) {
    throw new Error(
      'workday-mcp could not verify this GraphQL document is read-only: it does not parse ' +
        `(${messageOf(unreadable)}).`
    );
  }
  // Find an ALIASED selection of a secret- or PII-named field. The response
  // redactor matches PII by KEY name (`ssn`, `nationalIdentifier`,
  // `bankAccountNumber`), because GraphQL returns plain field-keyed JSON with
  // no sibling label to go on. But the response key is the caller's to choose:
  // an alias renames it, so `{ worker { a: nationalIdentifier } }` comes back
  // as `{ a: "..." }` and no key pattern can fire. One token defeats the
  // redactor, and the threat model is exactly a model (or an instruction
  // injected into fetched content) writing the query.
  const aliased = info.aliases.find((a) => isSecretKey(a.field))?.field;
  if (aliased) {
    throw new Error(
      `workday-mcp refuses to alias the sensitive field \`${aliased}\`: response redaction ` +
        'matches PII and secret fields by their key name, and an alias would rename it out ' +
        'of reach. Select the field under its own name (it will come back redacted).'
    );
  }
}

/** Find a named task in a profile's catalog: an exact label wins, then the
 *  first label containing it (in catalog order). */
function findProfileTask(
  sections: WorkdayProfileSection[],
  label: string
): { section: string; task: WorkdayReference } | null {
  const wanted = label.trim().toLowerCase();
  const all = sections.flatMap((s) =>
    s.tasks.filter((t) => t.uri).map((task) => ({ section: s.label, task }))
  );
  return (
    all.find((e) => e.task.label.toLowerCase() === wanted) ??
    all.find((e) => e.task.label.toLowerCase().includes(wanted)) ??
    null
  );
}

function describeCatalog(sections: WorkdayProfileSection[]): string {
  return (
    sections.map((s) => `${s.label}: ${s.tasks.map((t) => t.label).join(', ')}`).join(' | ') ||
    '(none)'
  );
}

/** The first cell whose column label matches, for grids whose column names
 *  vary slightly between tenants and report versions. */
function cellMatching(cells: Record<string, string>, pattern: RegExp): string | undefined {
  const key = Object.keys(cells).find((k) => pattern.test(k));
  return key ? cells[key] : undefined;
}

/** `MM/DD/YYYY` (Workday's US rendering) or ISO → sortable time; NaN if neither. */
function dateValue(s: string | undefined): number {
  if (!s) return NaN;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  return us ? Date.UTC(+us[3], +us[1] - 1, +us[2]) : Date.parse(s);
}

/** Pick one entry by label: exact (case-insensitive) beats a partial match,
 *  and several partial matches are an error that names them. */
function pickByLabel<T>(items: T[], label: (t: T) => string, wanted: string, what: string): T {
  const w = wanted.trim().toLowerCase();
  const exact = items.filter((i) => label(i).toLowerCase() === w);
  if (exact.length === 1) return exact[0];
  const partial = items.filter((i) => label(i).toLowerCase().includes(w));
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : items).map(label);
  throw new Error(
    partial.length
      ? `"${wanted}" matches more than one ${what}: ${names.join(' | ')}. Use a longer part of the name.`
      : `No ${what} matching "${wanted}". Available: ${names.join(' | ') || '(none)'}.`
  );
}

/** The Create Request page's request-type prompt: its id names the field in
 *  the flow POSTs, its contextId addresses the prompt-search endpoint. */
function parseTypeInput(page: Record<string, unknown>): { id: string; contextId: string } | null {
  let hit: { id: string; contextId: string } | null = null;
  const walk = (node: unknown, depth: number): void => {
    if (hit || depth > 40 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    if (
      o.widget === 'monikerListInput' &&
      typeof o.label === 'string' &&
      /request type/i.test(o.label) &&
      typeof o.id === 'string' &&
      typeof o.contextId === 'string'
    ) {
      hit = { id: o.id, contextId: o.contextId };
      return;
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(page.body, 0);
  return hit;
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
    this.host = normalizeHost(opts.host ?? readEnvVar('WORKDAY_HOST'));
    // Required for every data call, so read with requireEnvVar — but caught,
    // not thrown: the server must still boot for the install-time tools/list
    // probe, and the actionable message below surfaces on first use instead.
    let tenant = opts.tenant;
    if (tenant === undefined) {
      try {
        tenant = requireEnvVar('WORKDAY_TENANT');
      } catch {
        tenant = undefined;
      }
    }
    if (opts.configError) {
      this.configError = opts.configError;
    } else if (!tenant) {
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

  /** Fetch a Workday data endpoint and parse it into a flat, secret-free task.
   *
   *  The parser's allowlist keeps ENVELOPE secrets out, but it copies every
   *  text widget's `{label, value}` and every grid cell verbatim — so the
   *  government/financial PII rules of {@link redactTree} (sibling label, grid
   *  column) run here too, before parsing, exactly as they do for
   *  `fetchRawJson`. Otherwise a manager's `workday_get_worker_task` would
   *  return a report's bank account that `workday_fetch` withholds. The depth
   *  cap is raised well past the parser's own (40, relative to sub-roots) so
   *  redaction never truncates a subtree the parser would still read. */
  async getTask(path: string): Promise<WorkdayTask> {
    const resolved = this.resolvePath(path);
    const json = await this.fetchJson(resolved);
    return parseTask(redactTree(json, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
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
    return this.openProfileTask(profilePage, taskLabel, "this worker's profile");
  }

  /** Open one named task from an already-fetched profile page (a worker's or
   *  an organization's — both are `compositeView` catalogs). */
  private async openProfileTask(
    profilePage: WorkdayTask,
    taskLabel: string,
    where: string
  ): Promise<{ matched: string; section: string; uri: string; task: WorkdayTask }> {
    const sections = profilePage.profile?.sections ?? [];
    const hit = findProfileTask(sections, taskLabel);
    if (!hit) {
      throw new Error(
        `No task matching "${taskLabel}" on ${where}. Available — ${describeCatalog(sections)}`
      );
    }
    const uri = hit.task.uri as string;
    return { matched: hit.task.label, section: hit.section, uri, task: await this.getTask(uri) };
  }

  /**
   * The teams you manage: every SUPERVISORY organization you lead, with its
   * members.
   *
   * The org chart cannot do this — expanding it downward is a POST-only
   * navigation. Instead this follows plain GETs, each matched by LABEL so no
   * tenant id is assumed: your profile → "Organizations" → the "Manager/Leader
   * of These Organizations" grid → each supervisory org's own profile →
   * "Members".
   */
  async getTeam(): Promise<WorkdayTeam> {
    const me = await this.getMyProfile();
    const orgs = await this.openProfileTask(me, 'Organizations', 'your profile');
    const led = orgs.task.grids.find((g) => /manager|leader/i.test(g.label));
    const supervisory = (led?.rows ?? []).filter((row) => {
      const type = cellMatching(row.cells, /type/i);
      return type === undefined || /supervisory/i.test(type);
    });
    if (!supervisory.length) {
      throw new Error(
        'You do not manage any supervisory organization in Workday (your profile\'s ' +
          '"Organizations" lists no supervisory org under "Manager/Leader of"), so there is no ' +
          'team to list. Use `workday_get_org_chart` to see your reporting chain instead.'
      );
    }
    const organizations: WorkdayTeamOrg[] = [];
    for (const row of supervisory) {
      // Take the reference that IS the "Organization" cell. Matching on the
      // reference's label is not enough: live cells are labelled by column,
      // and "Organization Role" (a link to the role "Manager") matches too.
      const name = cellMatching(row.cells, /^organization$/i);
      const ref = row.references.find((r) => r.uri && name !== undefined && r.value === name);
      if (!name || !ref?.uri) continue;
      const orgPage = await this.getTask(ref.uri);
      const membersPage = await this.openProfileTask(orgPage, 'Members', `the "${name}" organization`);
      const grid = membersPage.task.grids.find((g) => /member/i.test(g.label)) ?? membersPage.task.grids[0];
      const members: WorkdayTeamMember[] = (grid?.rows ?? []).map((r) => {
        const primary =
          Object.keys(r.cells).find((k) => /^(associate|worker|employee|name)$/i.test(k)) ??
          Object.keys(r.cells)[0] ??
          '';
        const person = r.references.find((x) => x.instanceId && x.value === r.cells[primary]);
        const details = Object.fromEntries(Object.entries(r.cells).filter(([k]) => k !== primary));
        return {
          name: r.cells[primary] ?? person?.value ?? '',
          ...(person?.instanceId ? { workerId: person.instanceId } : {}),
          ...(person?.uri ? { profileUri: this.resolvePath(person.uri) } : {}),
          details,
        };
      });
      const shown = grid?.rows.length ?? 0;
      const total = grid?.totalRowCount;
      organizations.push({
        name,
        ...(ref.instanceId ? { id: ref.instanceId } : {}),
        members,
        ...(total !== undefined && total > shown ? { incomplete: { shown, total } } : {}),
      });
    }
    return { organizations };
  }

  /** A worker's performance-review history (newest first, as Workday lists it). */
  async getReviews(worker: string): Promise<{ reviews: WorkdayReviewSummary[] }> {
    const page = await this.getWorkerTask(worker, 'Performance Reviews');
    const reviews: WorkdayReviewSummary[] = [];
    for (const grid of page.task.grids) {
      for (const row of grid.rows) {
        const review = cellMatching(row.cells, /^review$/i);
        if (!review) continue;
        const periodStart = cellMatching(row.cells, /start/i);
        const periodEnd = cellMatching(row.cells, /end date|period end/i);
        const rating = cellMatching(row.cells, /rating/i);
        // The row action column ("View Review"). Anchored: the "Review"
        // column's own link would match a bare /view/.
        const view = row.references.find((r) => /^view\b/i.test(r.label) && r.uri);
        reviews.push({
          review,
          status: grid.label,
          ...(periodStart ? { periodStart } : {}),
          ...(periodEnd ? { periodEnd } : {}),
          ...(rating ? { rating } : {}),
          ...(view?.uri ? { viewUri: view.uri } : {}),
        });
      }
    }
    return { reviews };
  }

  /**
   * Read one review in full: every section's ratings and comments (manager
   * and employee), goals, and development items.
   *
   * `which` is part of the review's name ("2025 year-end") or `latest`. The
   * review's printable view is a task wizard whose sections are each a
   * GET-able page; they are read in turn.
   */
  async getReview(worker: string, which: string): Promise<WorkdayReview> {
    const { reviews } = await this.getReviews(worker);
    const viewable = reviews.filter((r) => r.viewUri);
    let summary: WorkdayReviewSummary;
    if (which.trim().toLowerCase() === 'latest') {
      if (!viewable.length) throw new Error('This worker has no performance review you can view.');
      summary = viewable.reduce((best, r) =>
        dateValue(r.periodEnd) > dateValue(best.periodEnd) ? r : best
      );
    } else {
      summary = pickByLabel(viewable, (r) => r.review, which, 'review');
    }
    const wizard = await this.getRedacted(summary.viewUri as string);
    const sectionRefs = parseWizardSections(wizard);
    const heading = parseTask(wizard)
      .sections.flatMap((s) => s.references)
      .find((r) => r.label === 'Sub-Heading Instance')?.value;
    const pages = sectionRefs.length
      ? await mapWithConcurrency(sectionRefs, 3, async (ref) => ({
          name: ref.label,
          page: await this.getRedacted(ref.uri),
        }))
      : [{ name: summary.review, page: wizard }];
    const sections = pages.map(({ name, page }) => {
      const grids = parseTask(page).grids.filter((g) => g.rows.length);
      return { name, values: parseFormValues(page), ...(grids.length ? { grids } : {}) };
    });
    return {
      review: summary.review,
      ...(summary.periodStart ? { periodStart: summary.periodStart } : {}),
      ...(summary.periodEnd ? { periodEnd: summary.periodEnd } : {}),
      ...(summary.rating ? { rating: summary.rating } : {}),
      ...(heading ? { heading } : {}),
      sections,
    };
  }

  /** Feedback a worker received, gave, or requested, one row per item. */
  async getFeedback(
    worker: string,
    kind: FeedbackKind = 'received'
  ): Promise<{ matched: string; feedback: Array<Record<string, string>>; incomplete?: { shown: number; total: number } }> {
    const page = await this.getWorkerTask(worker, FEEDBACK_TASKS[kind]);
    const rows = page.task.grids.flatMap((g) => g.rows.map((r) => r.cells));
    const shown = page.task.grids.reduce((n, g) => n + g.rows.length, 0);
    const total = page.task.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
    return {
      matched: page.matched,
      feedback: rows,
      ...(total > shown ? { incomplete: { shown, total } } : {}),
    };
  }

  /**
   * Load the form of a Workday REQUEST type (e.g. a promotion consideration
   * form) and return its questions — without creating a request.
   *
   * Workday renders a request's form only inside the "Create Request" flow,
   * so this drives that flow the way the UI does and then abandons it:
   *
   *   1. GET the Create Request task — opens the request-type prompt.
   *   2. POST a prompt search for `requestType`.
   *   3. POST the chosen type into the prompt (`_eventId_add`).
   *   4. POST the prompt's OK (`_eventId_submit` on the PROMPT page).
   *   5. ALWAYS POST `_eventId_cancel`, whatever happened above.
   *
   * Nothing is saved until a form's own Submit / Save for Later is pressed,
   * and this never sends either: step 4 is refused if the current page
   * already carries the business-process Submit bar, and no step ever names a
   * button from that bar. Verified live: the abandoned flow leaves nothing
   * under "My Requests" or "Requests In Progress".
   */
  async getRequestForm(requestType: string): Promise<WorkdayRequestForm> {
    const prompt = (await this.fetchJson(`/${this.tenant}/task/${CREATE_REQUEST_TASK}.htmld`)) as Record<
      string,
      unknown
    >;
    const flowKey = typeof prompt.flowExecutionKey === 'string' ? prompt.flowExecutionKey : undefined;
    const body = (prompt.body ?? {}) as Record<string, unknown>;
    const okId = typeof body.id === 'string' ? body.id : undefined;
    const typeInput = parseTypeInput(prompt);
    if (!flowKey || !okId || !typeInput || hasSubmitBar(prompt)) {
      if (flowKey) await this.cancelFlow(flowKey);
      throw new Error(
        'Workday\'s Create Request task did not open its request-type prompt, so the form cannot ' +
          'be loaded safely. Open "Create Request" in your browser to check you can create requests.'
      );
    }
    try {
      const found = (await this.postForm(
        `/${this.tenant}/prompt/${typeInput.contextId}/${typeInput.id}.htmld`,
        { _flowExecutionKey: flowKey, _eventId_prompt: typeInput.id, q: requestType }
      )) as { items?: Array<{ instanceId?: string; text?: string }> };
      const items = (found.items ?? []).filter(
        (i): i is { instanceId: string; text: string } => !!i.instanceId && !!i.text
      );
      if (!items.length) {
        throw new Error(
          `No request type matching "${requestType}" that you can create. Use a distinctive part ` +
            'of the name as it appears under Requests → Create Request.'
        );
      }
      const pick = pickByLabel(items, (i) => i.text, requestType, 'request type');
      const iid = pick.instanceId;
      await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_add: typeInput.id,
        [typeInput.id]: iid,
        [`${iid}_DID`]: pick.text,
        [`${iid}_IID`]: iid,
        [`${iid}_PV`]: '1',
        [`${iid}_V`]: '1',
      });
      // The prompt's OK. Safe ONLY because the page it confirms is the prompt
      // checked above — the same event on a loaded form would submit it.
      const form = await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_submit: okId,
      });
      const questionnaire = parseQuestionnaire(redactTree(form, { maxDepth: TYPED_REDACT_MAX_DEPTH }));
      if (!questionnaire) {
        throw new Error(
          `The "${pick.text}" request opened, but its form is not a questionnaire this server can ` +
            'read. Open it from Requests → Create Request in your browser.'
        );
      }
      return { requestType: pick.text, ...questionnaire };
    } finally {
      await this.cancelFlow(flowKey);
    }
  }

  /**
   * Your Workday inbox ("My Tasks"): review steps, feedback requests,
   * questionnaires and approvals waiting for you.
   *
   * The inbox is a JSON API, not an `.htmld` page, and it wants a DIFFERENT
   * session token from the envelope one: the token inside `boot-config`'s
   * `appRoot` (itself a JSON string). With the envelope token it answers
   * with the HTML app shell. The token is read here, sent as a header, and
   * never returned. Read-only: a plain GET.
   */
  async getInbox(
    category: InboxCategory = 'actions',
    limit = 100
  ): Promise<{ total: number; items: WorkdayInboxItem[] }> {
    const token = await this.inboxToken();
    const cat = category === 'archive' ? 'Archive' : 'Actions';
    const path =
      `/${this.tenant}/internalapi/internalapi/inbox/v2/${this.tenant}/inboxItems` +
      `?category=${cat}&offset=0&limit=${limit}`;
    const result = await this.transport.fetch({
      path,
      method: 'GET',
      headers: { Accept: 'application/json', 'Session-Secure-Token': token },
    });
    this.throwIfNotOk(result, 'GET', path);
    this.throwIfSignedOut(result);
    let json: unknown;
    try {
      json = JSON.parse(result.body);
    } catch {
      throw new Error(
        'Workday answered the inbox request with a web page instead of inbox data, which means ' +
          'it did not accept the inbox session token. Reload your Workday tab and retry.'
      );
    }
    const safe = redactTree(json) as { total?: unknown; data?: unknown };
    const data = Array.isArray(safe.data) ? safe.data : Array.isArray(safe) ? safe : [];
    const items = data.map((raw) => this.inboxItem(raw)).filter((i): i is WorkdayInboxItem => i !== null);
    return { total: typeof safe.total === 'number' ? safe.total : items.length, items };
  }

  private inboxItem(raw: unknown): WorkdayInboxItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, Record<string, unknown> | undefined>;
    const rel = o.relatedItem ?? {};
    const exec = o.taskToExecute ?? {};
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const title = str(rel.title);
    if (!title) return null;
    const type = str((rel.itemType as Record<string, unknown> | undefined)?.descriptor);
    const uri = str(exec.uri);
    const details = (Array.isArray(o.relatedTasks) ? (o.relatedTasks as Array<Record<string, unknown>>) : []).find(
      (t) => t?.label === 'View Details'
    );
    const detailsUri = str(details?.uri);
    return {
      title,
      ...(type ? { type } : {}),
      ...(str(exec.label) ? { task: str(exec.label) } : {}),
      ...(str(rel.createdDate) ? { created: str(rel.createdDate) } : {}),
      ...(str(rel.effectiveDate) ? { effective: str(rel.effectiveDate) } : {}),
      ...((o.status as Record<string, unknown> | undefined)?.starred === true ? { starred: true } : {}),
      ...(uri ? { uri: this.resolvePath(uri) } : {}),
      ...(detailsUri ? { detailsUri: this.resolvePath(detailsUri) } : {}),
    };
  }

  /** The inbox API's session token, from `boot-config` → `appRoot` (a JSON
   *  string). Held only for the request; never stored or returned. */
  private async inboxToken(): Promise<string> {
    const body = await this.fetchRaw(`/${this.tenant}/boot-config`);
    let token: unknown;
    try {
      const appRoot = (JSON.parse(stripJsonGuard(body)) as { appRoot?: unknown }).appRoot;
      const root = typeof appRoot === 'string' ? JSON.parse(appRoot) : appRoot;
      token = (root as Record<string, unknown> | undefined)?.sessionSecureToken;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || !token) {
      throw new Error(
        'Workday\'s boot-config did not include the inbox session token, so the inbox cannot be ' +
          'read. Reload your Workday tab and retry.'
      );
    }
    return token;
  }

  /** The requests you created (e.g. promotion consideration forms you
   *  submitted) with their status, from Workday's delivered "My Requests". */
  async getMyRequests(): Promise<{ requests: Array<Record<string, string>>; incomplete?: { shown: number; total: number } }> {
    const page = await this.getTask(`/${this.tenant}/task/${MY_REQUESTS_TASK}.htmld`);
    if (!/my requests/i.test(page.title ?? '')) {
      throw new Error(
        `Workday's My Requests report returned "${page.title ?? 'an untitled page'}" instead. Open ` +
          'Requests → My Requests in your browser to check you can see it.'
      );
    }
    const requests = page.grids.flatMap((g) => g.rows.map((r) => r.cells));
    const total = page.grids.reduce((n, g) => n + (g.totalRowCount ?? g.rows.length), 0);
    return { requests, ...(total > requests.length ? { incomplete: { shown: requests.length, total } } : {}) };
  }

  /** Abandon a flow. Best effort: a failure here must not mask the result. */
  private async cancelFlow(flowKey: string): Promise<void> {
    try {
      await this.postForm(`/${this.tenant}/flowController.htmld`, {
        _flowExecutionKey: flowKey,
        _eventId_cancel: 'Cancel',
      });
    } catch {
      // The flow expires with the page context anyway.
    }
  }

  /** GET a page and return it redacted but unparsed, for the readers that
   *  need widgets `parseTask` does not keep (form values, wizard sections). */
  private async getRedacted(path: string): Promise<unknown> {
    const json = await this.fetchJson(this.resolvePath(path));
    return redactTree(json, { maxDepth: TYPED_REDACT_MAX_DEPTH });
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
   *
   * `opts.retryOnTimeout` re-sends once after a bridge timeout. Leave it unset
   * (the default) for anything that might write; only a provably read-only
   * POST — {@link graphql}, whose document is guarded to `query` — sets it.
   */
  async postJson(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    opts: { retryOnTimeout?: boolean } = {}
  ): Promise<unknown> {
    const result = await this.transport.fetch({
      path,
      method: 'POST',
      ...(opts.retryOnTimeout ? { retryOnTimeout: true } : {}),
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
   * POST one step of a Workday UI flow (`flowController`, a prompt search):
   * a form-urlencoded body carrying the session token, exactly as the web app
   * sends it. The token rides in the body and the `Session-Secure-Token`
   * header and never leaves this method.
   *
   * Never retried: a flow step moves server-side flow state, so re-sending it
   * after a bridge timeout could apply it twice.
   */
  private async postForm(path: string, params: Record<string, string>): Promise<unknown> {
    await this.primeSessionToken();
    const token = this.sessionSecureToken;
    if (!token) {
      throw new Error(
        'Workday did not hand out a session token, so this step cannot be sent. Reload your ' +
          'Workday tab and retry.'
      );
    }
    const result = await this.transport.fetch({
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'Session-Secure-Token': token,
      },
      body: new URLSearchParams({
        ...params,
        sessionSecureToken: token,
        clientRequestID: randomUUID().replace(/-/g, ''),
      }).toString(),
    });
    this.throwIfNotOk(result, 'POST', path);
    this.throwIfSignedOut(result);
    try {
      const json = JSON.parse(stripJsonGuard(result.body));
      this.rememberSessionToken(json);
      return json;
    } catch (e) {
      throw new Error(`Workday POST ${path} returned a non-JSON body (${(e as Error).message}).`);
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
    // Read-only by the guard above (`query` operations only), so a bridge
    // timeout is safe to retry — fetchproxy >= 3.2.0 no longer re-sends POSTs
    // unless asked (chrischall/fleet-audit#312).
    const response = await this.postJson(
      `/wday/pex/graphql/graphql${op}`,
      {
        query,
        variables,
        ...(operationName ? { operationName } : {}),
      },
      {},
      { retryOnTimeout: true }
    );
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
    // A CDN/WAF refusal page answers 403 like a dead session, but the request
    // never reached Workday — name it before the 401/403 branch sends the user
    // back through SSO.
    const edge = detectEdgeBlock({ body: result.body, status: result.status });
    if (edge !== null) {
      throw new EdgeBlockedError(result.status, edge.vendor, { service: 'Workday', method, path });
    }
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
