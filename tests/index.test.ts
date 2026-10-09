import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerTaskTools } from '../src/tools/task.js';
import { registerAppsTools } from '../src/tools/apps.js';
import { registerPeopleTools } from '../src/tools/people.js';
import { registerRawTools } from '../src/tools/raw.js';
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
    registerAppsTools(server, client);
    registerTaskTools(server, client);
    registerPeopleTools(server, client);
    registerRawTools(server, client);
    expect(names).toEqual([
      'workday_healthcheck',
      'workday_get_apps',
      'workday_open_app',
      'workday_get_task',
      'workday_get_org_chart',
      'workday_get_worker',
      'workday_get_worker_task',
      'workday_get_my_profile',
      'workday_fetch',
      'workday_graphql',
    ]);
  });
});

describe('manifest.json tool list', () => {
  const client = new WorkdayClient({ transport: new StubTransport(), tenant: 'acme' });

  it('advertises exactly the tools the server registers', async () => {
    const { readFileSync } = await import('node:fs');
    const manifest = JSON.parse(
      readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
    ) as { tools: Array<{ name: string; description?: string }> };
    const { server, names } = fakeServer();
    registerHealthcheckTools(server, client);
    registerAppsTools(server, client);
    registerTaskTools(server, client);
    registerPeopleTools(server, client);
    registerRawTools(server, client);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([...names].sort());
    for (const t of manifest.tools) expect(t.description, t.name).toBeTruthy();
  });
});
