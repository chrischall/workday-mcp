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
import { formatApiError, readEnvVar } from '@chrischall/mcp-utils';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchResult,
  WorkdayTransport,
} from './transport.js';
import { parseTask, type WorkdayTask } from './parse.js';

const DEFAULT_HOST = 'wd5.myworkday.com';

export class SessionNotAuthenticatedError extends Error {
  constructor(host: string) {
    super(
      `Not signed in to Workday (or the session expired). Open https://${host} in your ` +
        `browser, complete the SSO sign-in, and try again. Every workday-mcp request rides ` +
        `your live, signed-in browser tab — there is no separate server-side login.`
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

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

/** Strip a leading anti-CSRF/guard prefix (anything before the first `{`)
 *  from a Workday JSON body. Live tenants currently emit clean JSON, but
 *  classic Workday endpoints have historically guarded it. */
export function stripJsonGuard(body: string): string {
  const start = body.indexOf('{');
  return start > 0 ? body.slice(start) : body;
}

export class WorkdayClient {
  private readonly transport: WorkdayTransport;
  readonly host: string;
  private readonly tenantValue: string | undefined;
  private readonly configError: WorkdayConfigError | undefined;

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
    if (!p.startsWith('/')) p = `/${this.tenant}/${p}`;
    p = p.replace(`/${this.tenant}/d/`, `/${this.tenant}/`);
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
      return JSON.parse(stripped);
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

  private throwIfNotOk(result: FetchResult, method: string, path: string): void {
    if (result.status >= 200 && result.status < 300) return;
    if (result.status === 401 || result.status === 403) {
      throw new SessionNotAuthenticatedError(this.host);
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
    if (looksLikeSso) throw new SessionNotAuthenticatedError(this.host);
  }
}
