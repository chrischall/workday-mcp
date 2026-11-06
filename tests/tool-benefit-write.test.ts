import { describe, it, expect, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { WorkdayClient } from '../src/client.js';
import { registerBenefitTools } from '../src/tools/benefits.js';
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
  registerBenefitTools(server, client);
  return { client, tools, tool: tools.get('workday_update_benefit_enrollment')! };
}

const plan = (revision = 'rev-1') => ({
  event: 'Open Enrollment Change: Pat Doe on 01/01/2027',
  inboxUri: '/acme/inst/2363$1/rel-task/2997$1195.htmld',
  startUri: '/acme/inst/2363$1/rel-task/2997$15223',
  action: 'submit' as const,
  steps: [{ planType: 'USA Dependent Care FSA', uri: '/acme/inst/8085$5/rel-task/2997$15286', waive: true }],
  preview: {
    event: 'Open Enrollment Change: Pat Doe on 01/01/2027',
    deadline: '11/08/2026',
    action: 'submit' as const,
    changes: [{ planType: 'USA Dependent Care FSA', from: 'Acme FSA Co', to: 'Waived' }],
  },
  revision,
});
const result = { event: plan().event, action: 'submit' as const, changes: plan().preview.changes, verified: true, verification: 'submitted' };
const ARGS = { changes: [{ planType: 'dependent care', waive: true }], action: 'submit' };
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe('workday_update_benefit_enrollment — confirm-token gated', () => {
  it('is a declared, non-destructive write', () => {
    expect(harness().tool.config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('phase 1 returns a preview (with the signature warning on submit) and a token, and writes NOTHING', async () => {
    const { client, tool } = harness();
    vi.spyOn(client, 'planBenefitUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyBenefitUpdate');
    const res = parse(await tool.cb(ARGS, NO_ELICIT_CTX));
    expect(res.status).toBe('confirmation-required');
    expect(typeof res.confirmToken).toBe('string');
    expect(JSON.stringify(res.preview)).toContain('Waived');
    expect(JSON.stringify(res)).toMatch(/electronic signature/i);
    expect(apply).not.toHaveBeenCalled();
  });

  it('phase 2 with the token writes exactly once, and a token cannot be spent twice', async () => {
    const { client, tool } = harness();
    vi.spyOn(client, 'planBenefitUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyBenefitUpdate').mockResolvedValue(result);
    const { confirmToken } = parse(await tool.cb(ARGS, NO_ELICIT_CTX));
    const res = parse(await tool.cb({ ...ARGS, confirmToken }, NO_ELICIT_CTX));
    await tool.cb({ ...ARGS, confirmToken }, NO_ELICIT_CTX);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res)).toContain('"verified":true');
  });

  it('refuses a token minted for a different state of the enrollment', async () => {
    const { client, tool } = harness();
    const planSpy = vi.spyOn(client, 'planBenefitUpdate').mockResolvedValue(plan('rev-1'));
    const apply = vi.spyOn(client, 'applyBenefitUpdate');
    const { confirmToken } = parse(await tool.cb(ARGS, NO_ELICIT_CTX));
    planSpy.mockResolvedValue(plan('rev-2')); // elections changed in the browser in between
    const res = await tool.cb({ ...ARGS, confirmToken }, NO_ELICIT_CTX);
    expect(apply).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/DRAFT_CHANGED|changed/i);
  });

  it('refuses a token minted for other changes or another action', async () => {
    const { client, tool } = harness();
    vi.spyOn(client, 'planBenefitUpdate').mockResolvedValue(plan());
    const apply = vi.spyOn(client, 'applyBenefitUpdate');
    const { confirmToken } = parse(await tool.cb(ARGS, NO_ELICIT_CTX));
    await tool.cb({ ...ARGS, changes: [{ planType: 'medical', waive: true }], confirmToken }, NO_ELICIT_CTX);
    await tool.cb({ ...ARGS, action: 'save', confirmToken }, NO_ELICIT_CTX);
    expect(apply).not.toHaveBeenCalled();
  });
});
