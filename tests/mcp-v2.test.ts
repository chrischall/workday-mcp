import { afterAll, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { WorkdayClient } from '../src/client.js';
import { registerAppsTools } from '../src/tools/apps.js';
import type {
  BridgeProbeResult,
  BridgeStatus,
  WorkdayTransport,
} from '../src/transport.js';

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

describe('MCP v2 tool schemas', () => {
  let harness: Awaited<ReturnType<typeof createTestHarness>>;

  afterAll(async () => {
    if (harness) await harness.close();
  });

  it('advertises real JSON Schema through the v2 client', async () => {
    const client = new WorkdayClient({
      transport: new StubTransport(),
      tenant: 'acme',
    });
    harness = await createTestHarness((server) =>
      registerAppsTools(server, client)
    );

    const tools = (await harness.client.listTools()).tools;
    const openApp = tools.find((tool) => tool.name === 'workday_open_app');
    expect(openApp?.inputSchema).toMatchObject({
      type: 'object',
      required: ['app'],
      properties: {
        app: expect.objectContaining({ type: 'string' }),
        depth: expect.objectContaining({ type: 'integer' }),
      },
    });

    const getApps = tools.find((tool) => tool.name === 'workday_get_apps');
    expect(getApps?.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
    });
  });
});
