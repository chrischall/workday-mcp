import { describe, it, expect, vi } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type { FeedbackRequestStatus } from '../src/feedback-view.js';
import type { BridgeProbeResult, BridgeStatus, WorkdayTransport } from '../src/transport.js';

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

const req = (about: string, by: string, date: string, status: string, waitingOn: string[] = []): FeedbackRequestStatus => ({
  request: `Feedback Request: ${about} requested by ${by}`,
  about,
  requestedBy: by,
  'Request Date': date,
  Status: status,
  asked: waitingOn,
  answeredBy: [],
  waitingOn,
  questions: [],
});

function client(pages: Record<string, FeedbackRequestStatus[] | Error>, team = true) {
  const c = new WorkdayClient({ transport: new NoTransport(), tenant: 'acme', host: 'wd5.myworkday.com' });
  vi.spyOn(c, 'resolveWorker').mockResolvedValue({ id: '247$9', name: 'Pat Doe' });
  const getTeam = vi.spyOn(c, 'getTeam');
  if (team) {
    getTeam.mockResolvedValue({
      organizations: [
        {
          name: 'Team',
          id: '2500$1',
          members: [
            { name: 'Sam Roe', workerId: '247$1', details: {} },
            { name: 'Lee Ray', workerId: '247$2', details: {} },
          ],
        },
      ],
    } as never);
  } else {
    getTeam.mockRejectedValue(new Error('You do not manage any supervisory organization'));
  }
  vi.spyOn(c, 'getFeedback').mockImplementation(async (worker) => {
    const page = pages[worker!];
    if (page instanceof Error) throw page;
    return { matched: 'Feedback Requested', worker: worker!, feedback: page ?? [] };
  });
  return c;
}

describe('getFeedbackStatus', () => {
  const today = new Date().toLocaleDateString('en-US');

  it('collects the requests YOU made, on yourself and on each person on your team', async () => {
    const c = client({
      '247$9': [req('Pat Doe', 'Pat Doe', today, 'In Progress', ['Kim Fox'])],
      '247$1': [req('Sam Roe', 'Pat Doe', today, 'In Progress', ['Lee Ray']), req('Sam Roe', 'Sam Roe', today, 'In Progress')],
      '247$2': [],
    });
    const out = await c.getFeedbackStatus();
    expect(out.requestedBy).toBe('Pat Doe');
    expect(out.requests.map((r) => [r.about, r.waitingOn])).toEqual([
      ['Pat Doe', ['Kim Fox']],
      ['Sam Roe', ['Lee Ray']],
    ]);
    expect(c.getFeedback).toHaveBeenCalledTimes(3);
  });

  it('keeps open requests whatever their age, and completed ones only from the last `days`', async () => {
    const c = client({
      '247$9': [
        req('Pat Doe', 'Pat Doe', '01/02/2020', 'In Progress'),
        req('Pat Doe', 'Pat Doe', '01/02/2020', 'Completed'),
        req('Pat Doe', 'Pat Doe', today, 'Completed'),
      ],
    });
    const out = await c.getFeedbackStatus({ days: 30 });
    expect(out.requests.map((r) => [r['Request Date'], r.Status])).toEqual([
      [today, 'Completed'],
      ['01/02/2020', 'In Progress'],
    ]);
  });

  it('still answers for yourself when you manage no team', async () => {
    const c = client({ '247$9': [req('Pat Doe', 'Pat Doe', today, 'In Progress')] }, false);
    const out = await c.getFeedbackStatus();
    expect(out.requests).toHaveLength(1);
  });

  it('names a person whose page could not be read instead of failing the whole call', async () => {
    const c = client({ '247$9': [], '247$1': new Error('Workday refused'), '247$2': [] });
    const out = await c.getFeedbackStatus();
    expect(out.unread).toEqual([{ worker: 'Sam Roe', error: 'Workday refused' }]);
  });

  it('filters by YOUR name even when the org chart does not give it, learning it from a page', async () => {
    const c = client({
      '247$9': [req('Pat Doe', 'Pat Doe', today, 'In Progress')],
      '247$1': [req('Sam Roe', 'Sam Roe', today, 'In Progress'), req('Sam Roe', 'Pat Doe', today, 'In Progress')],
      '247$2': [],
    });
    vi.spyOn(c, 'resolveWorker').mockResolvedValue({ id: '247$9' });
    vi.spyOn(c, 'fetchJson').mockResolvedValue({ widget: 'root', currentUser: { label: 'Pat Doe', iid: '247$9' }, body: {} });
    const inner = (c.getFeedback as unknown as { getMockImplementation: () => (w?: string) => Promise<unknown> }).getMockImplementation();
    vi.spyOn(c, 'getFeedback').mockImplementation(async (worker) => {
      await c.getTask('/acme/inst/x/y.htmld'); // as the real read does
      return inner(worker) as never;
    });
    const out = await c.getFeedbackStatus();
    expect(out.requestedBy).toBe('Pat Doe');
    expect(out.requests.map((r) => r.request)).toEqual([
      'Feedback Request: Pat Doe requested by Pat Doe',
      'Feedback Request: Sam Roe requested by Pat Doe',
    ]);
  });
});
