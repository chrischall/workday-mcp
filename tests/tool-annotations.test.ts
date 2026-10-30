import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { WorkdayClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAppsTools } from '../src/tools/apps.js';
import { registerTaskTools } from '../src/tools/task.js';
import { registerPeopleTools } from '../src/tools/people.js';
import { registerRawTools } from '../src/tools/raw.js';
import { registerReviewTools } from '../src/tools/review.js';
import { registerRequestTools } from '../src/tools/requests.js';
import type { BridgeProbeResult, BridgeStatus, WorkdayTransport } from '../src/transport.js';

/**
 * Fleet annotation meta-test. `destructiveHint` DEFAULTS TO TRUE whenever
 * readOnlyHint is false, so a write that forgets to declare it publishes as
 * destructive and nothing fails — a considered `false` and a forgotten one
 * leave identical annotations. So every write must CHOOSE, and no read may
 * claim to be destructive. Reads the annotations off the wire (tools/list),
 * not a hand-kept list.
 *
 * workday-mcp's one write is workday_update_request (confirm-gated), so the
 * write checks below hold it to an explicit destructiveHint.
 */
interface Ann { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown }

class StubTransport implements WorkdayTransport {
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch() {
    return { status: 200, body: '{}', url: 'https://wd5.myworkday.com/x' };
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

let harness: Awaited<ReturnType<typeof createTestHarness>>;
let ann: Record<string, Ann | undefined>;

beforeAll(async () => {
  const client = new WorkdayClient({ transport: new StubTransport(), tenant: 'acme' });
  harness = await createTestHarness((s) => {
    registerHealthcheckTools(s, client);
    registerAppsTools(s, client);
    registerTaskTools(s, client);
    registerPeopleTools(s, client);
    registerRawTools(s, client);
    registerReviewTools(s, client);
    registerRequestTools(s, client);
  });
  ann = Object.fromEntries(
    (await harness.client.listTools()).tools.map((t) => [t.name, t.annotations as Ann | undefined]),
  );
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('tool annotations', () => {
  it('covers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(ann)).toHaveLength(19);
  });

  it('sets an explicit boolean readOnlyHint on every tool', () => {
    expect(
      Object.entries(ann).filter(([, a]) => typeof a?.readOnlyHint !== 'boolean').map(([n]) => n),
    ).toEqual([]);
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(ann)
      .filter(([, a]) => a?.readOnlyHint === false && typeof a?.destructiveHint !== 'boolean')
      .map(([n]) => n);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(ann)
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([n]) => n);
    expect(contradictory).toEqual([]);
  });

  it('marks every tool open-world (all of them reach Workday through the browser bridge)', () => {
    expect(Object.entries(ann).filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });

  it('has exactly one write — the confirm-gated request update — and no other', () => {
    // A new write must be added here on purpose, with a confirmWrite gate and
    // a gate test (see tests/tool-request-write.test.ts).
    expect(Object.entries(ann).filter(([, a]) => a?.readOnlyHint !== true).map(([n]) => n)).toEqual([
      'workday_update_request',
    ]);
  });
});
