import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { WorkdayClient } from '../src/client.js';
import { registerFeedbackTools } from '../src/tools/feedback.js';
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
  const tools = new Map<string, { cb: Cb; config: { annotations?: Record<string, unknown> } }>();
  const server = {
    registerTool: (name: string, config: never, cb: Cb) => tools.set(name, { cb, config }),
  } as unknown as McpServer;
  const client = new WorkdayClient({ transport: new StubTransport(), tenant: 'acme', host: 'wd5.myworkday.com' });
  registerFeedbackTools(server, client);
  return { client, tools };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

const givePlan = (revision = 'rev-1') => ({
  input: { to: 'Pat', feedback: 'Great work' },
  preview: { action: 'give' as const, to: 'Pat Doe', feedback: 'Great work', visibility: ['Shared: Share with others'] },
  revision,
});

const requestPlan = (revision = 'rev-1') => ({
  input: { from: ['Sam'], questions: ['How did I do?'] },
  preview: {
    action: 'request' as const,
    about: 'yourself',
    from: ['Sam Roe'],
    questions: ['How did I do?'],
    visibility: [],
  },
  revision,
});

describe.each([
  ['workday_give_feedback', { to: 'Pat', feedback: 'Great work' }, 'planGiveFeedback', 'applyGiveFeedback', givePlan, 'Pat Doe'],
  ['workday_request_feedback', { from: ['Sam'], questions: ['How did I do?'] }, 'planRequestFeedback', 'applyRequestFeedback', requestPlan, 'Sam Roe'],
] as const)('%s — confirm-token gated', (name, args, planFn, applyFn, makePlan, shown) => {
  it('is a declared, non-destructive write', () => {
    const { tools } = harness();
    expect(tools.get(name)?.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('phase 1 returns a preview and a token, and sends NOTHING', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, planFn).mockResolvedValue(makePlan() as never);
    const apply = vi.spyOn(client, applyFn);
    const res = parse(await tools.get(name)!.cb({ ...args }, NO_ELICIT_CTX));
    expect(res.status).toBe('confirmation-required');
    expect(typeof res.confirmToken).toBe('string');
    expect(JSON.stringify(res.preview)).toContain(shown);
    expect(apply).not.toHaveBeenCalled();
  });

  it('phase 2 with the token sends exactly once, and the token cannot be reused', async () => {
    const { client, tools } = harness();
    vi.spyOn(client, planFn).mockResolvedValue(makePlan() as never);
    const apply = vi
      .spyOn(client, applyFn)
      .mockResolvedValue({ ...makePlan().preview, verified: true, verification: 'ok' } as never);
    const tool = tools.get(name)!;
    const { confirmToken } = parse(await tool.cb({ ...args }, NO_ELICIT_CTX));
    const res = parse(await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX));
    await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res)).toContain('"verified":true');
  });

  it('passes `sharing` through to the plan', async () => {
    const { client, tools } = harness();
    const planSpy = vi.spyOn(client, planFn).mockResolvedValue(makePlan() as never);
    await tools.get(name)!.cb({ ...args, sharing: 'confidential' }, NO_ELICIT_CTX);
    expect(planSpy.mock.calls[0]![0]).toMatchObject({ sharing: 'confidential' });
  });

  it.runIf(name === 'workday_request_feedback')('passes `fill` through to the plan', async () => {
    const { client, tools } = harness();
    const planSpy = vi.spyOn(client, planFn).mockResolvedValue(makePlan() as never);
    await tools.get(name)!.cb({ ...args, template: 'aspiring', fill: { 'ENTER BEHAVIOR': 'delegating' } }, NO_ELICIT_CTX);
    expect(planSpy.mock.calls[0]![0]).toMatchObject({ fill: { 'ENTER BEHAVIOR': 'delegating' } });
  });

  it('refuses a token when Workday now resolves the form differently', async () => {
    const { client, tools } = harness();
    const planSpy = vi.spyOn(client, planFn).mockResolvedValue(makePlan('rev-1') as never);
    const apply = vi.spyOn(client, applyFn);
    const tool = tools.get(name)!;
    const { confirmToken } = parse(await tool.cb({ ...args }, NO_ELICIT_CTX));
    planSpy.mockResolvedValue(makePlan('rev-2') as never);
    await tool.cb({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(apply).not.toHaveBeenCalled();
  });
});
