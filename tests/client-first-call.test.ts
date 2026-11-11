import { describe, it, expect } from 'vitest';
import { FetchproxyTimeoutError } from '@chrischall/mcp-utils/fetchproxy';
import { WorkdayClient } from '../src/client.js';
import type { BridgeProbeResult, BridgeStatus, FetchInit, FetchResult, WorkdayTransport } from '../src/transport.js';

// Measured live (2026-11-10): the FIRST request of a new process waits for the
// browser extension to connect — 2 s, 9 s, 23 s, and once over 60 s, past
// fetchproxy's own timeout-and-retry. Once connected, Workday answers in
// ~100–400 ms. So until the bridge has answered once, a timed-out GET is
// tried again within a longer window; nothing else changes.

const timeout = (path: string) =>
  new FetchproxyTimeoutError({ url: `https://wd5.myworkday.com${path}`, timeoutMs: 30_000, retryAttempted: true });

/** Times out on the first `failures` calls, then answers. */
class FlakyTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  constructor(private failures: number) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    if (this.calls.length <= this.failures) throw timeout(init.path);
    return { status: 200, body: '{"widget":"root"}', url: `https://wd5.myworkday.com${init.path}` };
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

const client = (t: WorkdayTransport) => new WorkdayClient({ transport: t, tenant: 'acme', host: 'wd5.myworkday.com' });

describe('first call waits for the bridge', () => {
  it('retries a first GET that timed out while the extension was connecting', async () => {
    const t = new FlakyTransport(2);
    await expect(client(t).fetchJson('/acme/task/1$1.htmld')).resolves.toEqual({ widget: 'root' });
    expect(t.calls).toHaveLength(3);
  });

  it('gives up after its last attempt, with the bridge\'s own error', async () => {
    const t = new FlakyTransport(99);
    await expect(client(t).fetchJson('/acme/task/1$1.htmld')).rejects.toBeInstanceOf(FetchproxyTimeoutError);
    expect(t.calls).toHaveLength(3);
  });

  it('applies to fetchRaw too (the healthcheck probe)', async () => {
    const t = new FlakyTransport(1);
    await expect(client(t).fetchRaw('/acme/get-global-prefs.htmld')).resolves.toContain('root');
    expect(t.calls).toHaveLength(2);
  });

  it('once the bridge has answered, a timeout is not retried by the client', async () => {
    const t = new FlakyTransport(0);
    const c = client(t);
    await c.fetchJson('/acme/task/1$1.htmld');
    (t as unknown as { failures: number }).failures = 99;
    await expect(c.fetchJson('/acme/task/1$2.htmld')).rejects.toBeInstanceOf(FetchproxyTimeoutError);
    expect(t.calls).toHaveLength(2);
  });

  it('never retries a POST, even before the bridge has answered', async () => {
    const t = new FlakyTransport(1);
    await expect(client(t).postJson('/acme/x', {})).rejects.toBeInstanceOf(FetchproxyTimeoutError);
    expect(t.calls).toHaveLength(1);
  });

  it('does not retry other errors (a missing tab is not a slow connection)', async () => {
    const t = new FlakyTransport(0);
    t.fetch = async (init: FetchInit) => {
      t.calls.push(init);
      throw new Error('no tab matching https://wd5.myworkday.com/');
    };
    await expect(client(t).fetchJson('/acme/task/1$1.htmld')).rejects.toThrow(/no tab matching/);
    expect(t.calls).toHaveLength(1);
  });
});
