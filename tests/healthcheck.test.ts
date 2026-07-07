import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { WorkdayClient } from '../src/client.js';
import type {
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
  FetchInit,
  FetchResult,
} from '../src/transport.js';

/**
 * Drives the shared `registerBridgeHealthcheckTool` through a real
 * WorkdayClient + a fake transport whose `runProbe` mirrors the
 * `@fetchproxy/server` primitive (invoke the probe fn, catch its throw, project
 * a bridge snapshot). Asserts the black-box contract callers depend on:
 * `ok` / `bridge` / `error.kind` / `hint`.
 */
interface Scenario {
  role?: 'host' | 'peer' | null;
  errorKind?: string;
  /** What the client-facing `fetch` returns (drives the probe body / sign-in guard). */
  fetchResult?: FetchResult;
}

class ProbeTransport implements WorkdayTransport {
  constructor(private readonly scn: Scenario) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(_init: FetchInit): Promise<FetchResult> {
    return (
      this.scn.fetchResult ?? {
        status: 200,
        body: '{"data":1}',
        url: 'https://wd5.myworkday.com/acme/get-global-prefs.htmld',
      }
    );
  }
  async runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string,
  ): Promise<BridgeProbeResult> {
    const bridge = {
      role: this.scn.role ?? 'host',
      port: 37_149,
      server_version: '0.2.0',
      fetch_timeout_ms: 30_000,
      last_success_at: null,
      last_failure_at: null,
      last_failure_reason: null,
      consecutive_failures: 0,
    } as unknown as BridgeProbeResult['bridge'];
    try {
      await fetchFn(probePath);
      return { ok: true, elapsed_ms: 7, bridge } as BridgeProbeResult;
    } catch (e) {
      return {
        ok: false,
        elapsed_ms: 7,
        bridge,
        error: { kind: this.scn.errorKind ?? 'unknown', message: (e as Error).message },
      } as BridgeProbeResult;
    }
  }
  status(): BridgeStatus {
    return { lastExtensionMessageAt: 123 } as unknown as BridgeStatus;
  }
}

function runHealthcheck(scn: Scenario, over?: { tenant?: string }) {
  let handler: (() => Promise<{ content: { text: string }[] }>) | undefined;
  const server = {
    registerTool: (_name: string, _cfg: unknown, h: typeof handler) => {
      handler = h;
    },
  } as unknown as McpServer;
  const client = new WorkdayClient({
    transport: new ProbeTransport(scn),
    tenant: over && 'tenant' in over ? over.tenant : 'acme',
    host: 'wd5.myworkday.com',
  });
  registerHealthcheckTools(server, client);
  return async () => JSON.parse((await handler!()).content[0]!.text);
}

describe('workday_healthcheck', () => {
  it('reports a healthy round-trip with the shared bridge + probe shape', async () => {
    const result = await runHealthcheck({})();
    expect(result.ok).toBe(true);
    expect(result.bridge.role).toBe('host');
    expect(result.bridge.port).toBe(37_149);
    // New fields the shared tool supplies:
    expect(result.bridge.last_extension_message_at).toBe(123);
    expect(result.probe.status).toBe(200);
    expect(result.error).toBeUndefined();
    expect(result.hint).toMatch(/round-tripped/i);
  });

  it('maps an expired session to session_expired with SSO re-sign-in copy', async () => {
    const result = await runHealthcheck({
      errorKind: 'unknown',
      fetchResult: { status: 401, body: 'nope', url: 'https://wd5.myworkday.com/acme/x' },
    })();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('session_expired');
    expect(result.hint).toMatch(/session expired/i);
    expect(result.hint).toMatch(/SSO/);
  });

  it('surfaces the config error as not_configured when the tenant is unset', async () => {
    const result = await runHealthcheck({ errorKind: 'unknown' }, { tenant: undefined })();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('not_configured');
    expect(result.hint).toMatch(/WORKDAY_TENANT/);
  });

  it('passes a bridge_down classification through with the default hint', async () => {
    const result = await runHealthcheck({
      errorKind: 'bridge_down',
      role: null,
      fetchResult: { status: 500, body: 'x', url: 'https://wd5.myworkday.com/acme/x' },
    })();
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('bridge_down');
    expect(result.hint).toMatch(/service worker/i);
  });
});
