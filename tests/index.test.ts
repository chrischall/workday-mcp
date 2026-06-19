import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerTaskTools } from '../src/tools/task.js';
import { WorkdayClient } from '../src/client.js';
import type { WorkdayTransport, BridgeStatus, BridgeProbeResult } from '../src/transport.js';

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

/** Minimal McpServer stand-in that records registered tool names. */
function fakeServer(): { server: McpServer; names: string[] } {
  const names: string[] = [];
  const server = {
    registerTool: (name: string) => {
      names.push(name);
    },
  } as unknown as McpServer;
  return { server, names };
}

describe('tool registration', () => {
  const client = new WorkdayClient({ transport: new StubTransport(), tenant: 'acme' });

  it('registers the expected read-only tool roster', () => {
    const { server, names } = fakeServer();
    registerHealthcheckTools(server, client);
    registerTaskTools(server, client);
    expect(names).toEqual(['workday_healthcheck', 'workday_get_task']);
  });
});
