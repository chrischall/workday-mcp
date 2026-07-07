// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// workday-mcp's WorkdayTransport interface.
//
// The verb surface (fetch / runProbe / status / start / close) is the shared
// `createFetchproxyTransport` from @chrischall/mcp-utils/fetchproxy. This thin
// class keeps only the named export + optional per-request debug timing, and
// parameterizes the bridge target by the tenant host: a Workday data center
// host like `wd5.myworkday.com` maps to domain `myworkday.com` + subdomain
// `wd5`, so requests route to the right signed-in tab.
//
// Lazy-revive on Chrome MV3 service-worker eviction and per-request timeouts
// are @fetchproxy/server defaults. The convenience verbs throw typed
// `FetchproxyBridgeDownError` / `FetchproxyTimeoutError` (both subclasses of
// `FetchproxyProtocolError`) on failure.

import { splitHost } from '@chrischall/mcp-utils';
import {
  createFetchproxyTransport,
  type FetchproxyTransport as FetchproxyVerbTransport,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
  type BridgeError,
} from '@chrischall/mcp-utils/fetchproxy';
import type {
  BridgeProbeResult,
  BridgeStatus,
  FetchInit,
  FetchResult,
  WorkdayTransport,
} from './transport.js';

export {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  FetchproxyProtocolError,
  classifyBridgeError,
  // The shared `splitHost` (last-two-labels split) — re-exported so the
  // transport's tests and any importer keep resolving it from this module. For
  // real Workday data-center hosts (`wd5.myworkday.com`) it is identical to the
  // former local implementation.
  splitHost,
};
export type { BridgeError };

const DEFAULT_PORT = 37_149;

const DEBUG = process.env.WORKDAY_DEBUG === '1';

function log(...args: unknown[]): void {
  if (DEBUG) console.error('[workday-mcp:bridge]', ...args);
}

export interface FetchproxyTransportOptions {
  port?: number;
  /** Tenant host, e.g. `wd5.myworkday.com`. Determines the bridge domain
   *  + default subdomain. */
  host: string;
  /** MCP server name announced to the extension. Defaults to 'workday-mcp'. */
  server?: string;
  /** MCP server version. Should match the banner in index.ts. */
  version: string;
  /** Per-request timeout in ms. Omit to use the server's 30s default. */
  fetchTimeoutMs?: number;
}

export class FetchproxyTransport implements WorkdayTransport {
  private readonly inner: FetchproxyVerbTransport;
  private readonly port: number;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    const { domain, subdomain } = splitHost(opts.host);
    this.inner = createFetchproxyTransport<FetchproxyVerbTransport>({
      port: this.port,
      serverName: opts.server ?? 'workday-mcp',
      version: opts.version,
      logListening: true,
      domains: [domain],
      ...(subdomain ? { defaultSubdomain: subdomain } : {}),
      ...(opts.fetchTimeoutMs !== undefined
        ? { fetchTimeoutMs: opts.fetchTimeoutMs }
        : {}),
    });
  }

  async start(): Promise<void> {
    log('listen start', { port: this.port });
    await this.inner.start();
  }

  async close(): Promise<void> {
    log('close');
    return this.inner.close();
  }

  status(): BridgeStatus {
    return this.inner.status();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const start = Date.now();
    log('fetch:start', { method: init.method, path: init.path, role: this.inner.role });
    const response = await this.inner.fetch({
      method: init.method,
      path: init.path,
      headers: init.headers,
      body: init.body,
    });
    log('fetch:done', {
      path: init.path,
      elapsed: Date.now() - start,
      status: response.status,
      bodyLen: response.body.length,
    });
    return { status: response.status, body: response.body, url: response.url };
  }

  async runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string
  ): Promise<BridgeProbeResult> {
    return this.inner.runProbe(fetchFn, probePath);
  }
}
