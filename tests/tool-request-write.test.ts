import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { WorkdayClient } from '../src/client.js';
import { registerRequestTools } from '../src/tools/requests.js';
import type { BridgeProbeResult, BridgeStatus, WorkdayTransport } from '../src/transport.js';

/** A caller that cannot be prompted → the two-phase confirm-token flow. */
const NO_ELICIT_CTX = { mcpReq: { envelope: { 'io.modelcontextprotocol/clientCapabilities': {} } } };

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

type Cb = (args: Record<string, unknown>, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function harness() {
  const tools = new Map<string, { cb: Cb; config: { annotations?: Record<string, unknown>; description?: string } }>();
  const server = {
    registerTool: (name: string, config: never, cb: Cb) => tools.set(name, { cb, config }),
  } as unknown as McpServer;
  const client = new WorkdayClient({ transport: new StubTransport(), tenant: 'acme', host: 'wd5.myworkday.com' });
  registerRequestTools(server, client);
  return { client, tools };
}

const plan = (revision = 'rev-1') => ({
  request: '20447$1',
  uri: '/acme/inst/20447$1/rel-task/2997$12874.htmld',
  model: {} as never,
  steps: [{ _eventId_submit: '1579' }],
  preview: {
    request: '20447$1',
    action: 'submit' as const,
    changes: [{ number: 3, question: 'Organization Impact', from: null, to: 'Leads 4' }],
  },
  revision,
});

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('workday_update_request — confirm-token gated', () => {
  beforeEach(() => vi.unstubAllEnvs());

  it('is a declared write', () => {
    const { tools } = harness();
    expect(tools.get('workday_update_request')?.config.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
  });

  it('phase 1 returns a preview and a token, and writes NOTHING', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, 'planRequestUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyRequestUpdate');
    const res = parse(
      await tools.get('workday_update_request')!.cb(
        { request: '20447$1', answers: { '3': 'Leads 4' }, action: 'submit' },
        NO_ELICIT_CTX
      )
    );
    expect(res.status).toBe('confirmation-required');
    expect(typeof res.confirmToken).toBe('string');
    expect(JSON.stringify(res.preview)).toContain('Organization Impact');
    expect(JSON.stringify(res.preview)).toContain('Leads 4');
    expect(apply).not.toHaveBeenCalled();
  });

  it('phase 2 with the token writes exactly once', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, 'planRequestUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyRequestUpdate').mockResolvedValue({
      request: '20447$1',
      action: 'submit',
      changes: plan().preview.changes,
      verified: true,
      verification: 'submitted',
    });
    const args = { request: '20447$1', answers: { '3': 'Leads 4' }, action: 'submit' };
    const tool = tools.get('workday_update_request')!;
    const { confirmToken } = parse(await tool.cb(args, NO_ELICIT_CTX));
    const res = parse(await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ verified: true });
  });

  it('refuses a token minted for a different state of the request', async () => {
    const { client, tools } = harness();
    const planSpy = vi.spyOn(client, 'planRequestUpdate').mockResolvedValue(plan('rev-1'));
    const apply = vi.spyOn(client, 'applyRequestUpdate');
    const args = { request: '20447$1', answers: { '3': 'Leads 4' }, action: 'submit' };
    const tool = tools.get('workday_update_request')!;
    const { confirmToken } = parse(await tool.cb(args, NO_ELICIT_CTX));
    planSpy.mockResolvedValue(plan('rev-2')); // someone edited the request in between
    const res = await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(apply).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/DRAFT_CHANGED|changed/i);
  });

  it('refuses a token minted for different answers', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, 'planRequestUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyRequestUpdate');
    const tool = tools.get('workday_update_request')!;
    const { confirmToken } = parse(
      await tool.cb({ request: '20447$1', answers: { '3': 'Leads 4' }, action: 'submit' }, NO_ELICIT_CTX)
    );
    await tool.cb({ request: '20447$1', answers: { '3': 'Leads 40' }, action: 'submit', confirmToken }, NO_ELICIT_CTX);
    expect(apply).not.toHaveBeenCalled();
  });

  it('a token cannot be spent twice', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, 'planRequestUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyRequestUpdate').mockResolvedValue({
      request: '20447$1',
      action: 'submit',
      changes: [],
      verified: true,
      verification: 'ok',
    });
    const args = { request: '20447$1', answers: { '3': 'Leads 4' }, action: 'submit' };
    const tool = tools.get('workday_update_request')!;
    const { confirmToken } = parse(await tool.cb(args, NO_ELICIT_CTX));
    await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX);
    await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('workday_get_request — read-only', () => {
  it('lists open requests when none is named, and never writes', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, 'listOpenRequests').mockResolvedValue([{ request: '20447$1', title: 'Promotion' }]);
    const apply = vi.spyOn(client, 'applyRequestUpdate');
    const res = parse(await tools.get('workday_get_request')!.cb({}, NO_ELICIT_CTX));
    expect(JSON.stringify(res)).toContain('20447$1');
    expect(apply).not.toHaveBeenCalled();
    expect(tools.get('workday_get_request')?.config.annotations).toMatchObject({ readOnlyHint: true });
  });
});
