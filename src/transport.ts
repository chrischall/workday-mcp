// Transport-agnostic interface for the bridge that relays Workday fetches
// through the user's real, signed-in browser session.
//
// Workday tenants sit behind corporate SSO (Ping/Okta/Entra) with MFA, so
// there is no server-side login: every request must ride the user's already-
// authenticated `*.myworkday.com` tab. The default implementation in
// src/transport-fetchproxy.ts wraps @fetchproxy/server's FetchproxyServer
// (127.0.0.1:37149 WebSocket) and the shared fetchproxy browser extension.
//
// WorkdayClient (src/client.ts) accepts any WorkdayTransport. Error mapping
// (non-2xx, SSO/sign-in interstitial, JSON parse) lives on the client, not the
// transport — every implementation only round-trips the request and returns a
// {status, body, url} triple.

export interface FetchInit {
  /** Path-and-query relative to the tenant host, e.g.
   *  `/{tenant}/d/home.htmld` or `/{tenant}/card/all/...htmld`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling.
   *  Omitted for GETs. */
  body?: string;
}

export interface FetchResult {
  status: number;
  /** Response body as a string. Empty string for 204. */
  body: string;
  /** Final URL after redirects. Used for SSO/sign-in detection. */
  url: string;
}

/** Diagnostic snapshot returned by `WorkdayTransport.status()`. */
export type BridgeStatus =
  import('@chrischall/mcp-utils/fetchproxy').BridgeHealth;

/** Result of `WorkdayTransport.runProbe` — projection of the underlying
 *  `@chrischall/mcp-utils/fetchproxy` `BridgeProbeResult`. */
export type BridgeProbeResult =
  import('@chrischall/mcp-utils/fetchproxy').BridgeProbeResult;

export interface WorkdayTransport {
  /** Bring the transport up. Idempotent. */
  start(): Promise<void>;

  /** Tear the transport down. Idempotent. */
  close(): Promise<void>;

  /** Round-trip one request through the bridge. Resolves to a result triple
   *  even for non-2xx statuses — the client maps HTTP errors. */
  fetch(init: FetchInit): Promise<FetchResult>;

  /** Run one healthcheck probe through `fetchFn`, measure the round-trip,
   *  classify any thrown error, and project the post-probe bridge health. */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult>;

  /** Diagnostic snapshot of the bridge. Safe to call any time. */
  status(): BridgeStatus;
}
