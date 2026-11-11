import { describe, it, expect, vi } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import { parseTask } from '../src/parse.js';
import type { BridgeProbeResult, BridgeStatus, WorkdayTransport } from '../src/transport.js';
import { requestedPage } from './feedback-grid-fixtures.js';

class NoTransport implements WorkdayTransport {
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(): Promise<never> {
    throw new Error('no network in this test');
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

function client() {
  const c = new WorkdayClient({ transport: new NoTransport(), tenant: 'acme', host: 'wd5.myworkday.com' });
  vi.spyOn(c, 'getOrgChart').mockResolvedValue({
    workerId: '247$9',
    ancestors: [],
    nodes: [{ name: 'Pat Doe', instanceId: '247$9' }],
  });
  vi.spyOn(c, 'getTeam').mockResolvedValue({
    organizations: [
      {
        name: 'Team',
        id: '2500$1',
        members: [
          { name: 'Justin Kolodny', workerId: '247$1', details: {} },
          { name: 'Justine Kemp', workerId: '247$2', details: {} },
          { name: 'Ed Maki', workerId: '247$3', details: {} },
        ],
      },
    ],
  } as never);
  return c;
}

describe('resolveWorker', () => {
  it('reads omitted or `me` as you, with your name', async () => {
    const c = client();
    await expect(c.resolveWorker()).resolves.toEqual({ id: '247$9', name: 'Pat Doe' });
    await expect(c.resolveWorker('me')).resolves.toEqual({ id: '247$9', name: 'Pat Doe' });
    expect(c.getTeam).not.toHaveBeenCalled();
  });

  it('passes a worker id or a profile uri straight through', async () => {
    const c = client();
    await expect(c.resolveWorker('247$42')).resolves.toEqual({ id: '247$42' });
    await expect(c.resolveWorker('/acme/inst/15$1/247$42.htmld')).resolves.toEqual({ id: '/acme/inst/15$1/247$42.htmld' });
    expect(c.getTeam).not.toHaveBeenCalled();
  });

  it('finds a team member by name, a partial name or word starts', async () => {
    const c = client();
    await expect(c.resolveWorker('Ed Maki')).resolves.toEqual({ id: '247$3', name: 'Ed Maki' });
    await expect(c.resolveWorker('Justin K')).resolves.toEqual({ id: '247$1', name: 'Justin Kolodny' });
    await expect(c.resolveWorker('maki')).resolves.toEqual({ id: '247$3', name: 'Ed Maki' });
  });

  it('names the candidates when a name is ambiguous or unknown', async () => {
    const c = client();
    await expect(c.resolveWorker('Justin')).rejects.toThrow(/Justin Kolodny \| Justine Kemp/);
    await expect(c.resolveWorker('Nobody')).rejects.toThrow(/Ed Maki/);
  });
});

describe('getFeedback', () => {
  it('groups the grid and says whose feedback it read', async () => {
    const c = client();
    const task = parseTask(requestedPage);
    const spy = vi.spyOn(c, 'getWorkerTask').mockResolvedValue({ matched: 'Feedback Requested', section: 'Feedback', uri: '/x', task });
    const out = await c.getFeedback('Ed', 'requested');
    expect(spy).toHaveBeenCalledWith('247$3', 'Feedback Requested');
    expect(out.worker).toBe('Ed Maki');
    expect(out.feedback[0]).toMatchObject({ waitingOn: ['Sam Roe'], answeredBy: ['Lee Ray'] });
    expect(out.incomplete).toBeUndefined();
  });

  it('keeps flat, filled-in rows for write verification', async () => {
    const c = client();
    vi.spyOn(c, 'getWorkerTask').mockResolvedValue({ matched: 'Feedback Requested', section: 'Feedback', uri: '/x', task: parseTask(requestedPage) });
    const rows = await c.getFeedbackRows(undefined, 'requested');
    expect(rows[1]).toMatchObject({ Question: 'How am I doing?', 'Request Date': '11/10/2026', From: 'Lee Ray' });
  });
});
