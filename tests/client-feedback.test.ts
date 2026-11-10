import { describe, it, expect, vi } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';
import { associatePrompt, giveForm, questionRowAdded, requestForm, templateChosen } from './feedback-fixtures.js';

type Route = unknown | ((init: FetchInit) => unknown);

class RoutingTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  constructor(private routes: Record<string, Route>) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const route = this.routes[`${init.method} ${init.path}`] ?? this.routes[init.path];
    const hit = typeof route === 'function' ? (route as (i: FetchInit) => unknown)(init) : route;
    return {
      status: hit === undefined ? 404 : 200,
      body: hit === undefined ? 'not found' : JSON.stringify(hit),
      url: `https://wd5.myworkday.com${init.path}`,
    };
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

const FLOW = 'POST /acme/flowController.htmld';
const ok = { widget: 'changeSummary', changes: [] };
const done = { widget: 'root', body: { widget: 'vbox', id: '1', children: [{ widget: 'text', value: 'Submitted' }] } };

function posts(t: RoutingTransport): URLSearchParams[] {
  return t.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body));
}
function events(t: RoutingTransport): string[] {
  return posts(t).map((p) => {
    const k = [...p.keys()].find((x) => x.startsWith('_eventId_')) ?? '?';
    return `${k}=${p.get(k)}`;
  });
}

function makeClient(routes: Record<string, Route>) {
  const transport = new RoutingTransport(routes);
  const client = new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' });
  vi.spyOn(client, 'getOrgChart').mockResolvedValue({ workerId: '247$1', ancestors: [], nodes: [] });
  return { client, transport };
}

function giveRoutes(opts: { commit?: unknown; badStep?: string; people?: Array<{ instanceId: string; text: string }> } = {}) {
  return {
    '/acme/task/2997$3067.htmld': associatePrompt,
    'POST /acme/prompt/c0/66.htmld': { items: opts.people ?? [{ instanceId: '247$7', text: 'Pat Doe', subHeader: 'Ops' }] },
    [FLOW]: (init: FetchInit) => {
      const p = new URLSearchParams(init.body);
      if (p.get('_eventId_submit') === '72') return giveForm;
      if (p.get('_eventId_submit') === '944') return opts.commit ?? done;
      if (p.has('_eventId_cancel')) return {};
      if (opts.badStep && (p.get('_eventId_validate') === opts.badStep || p.get('_eventId_add') === opts.badStep)) {
        return { widget: 'root', unassociatedErrorNodes: [{ widget: 'error', message: 'Nope.', type: 'ERROR' }] };
      }
      if (p.get('_eventId_add') === '66') return {};
      return ok;
    },
  };
}

describe('WorkdayClient — give feedback', () => {
  it('plans by driving the form up to Submit, then cancels: nothing is sent', async () => {
    const { client, transport } = makeClient(giveRoutes());
    const plan = await client.planGiveFeedback({ to: 'Pat Doe', feedback: 'Great <work>.', badge: 'own it' });
    expect(plan.preview).toEqual({
      action: 'give',
      to: 'Pat Doe',
      feedback: 'Great <work>.',
      badge: 'I own it',
      visibility: ['Your name is shown', 'Shared: Share with others'],
    });
    expect(events(transport)).toEqual([
      '_eventId_prompt=66',
      '_eventId_add=66',
      '_eventId_submit=72',
      '_eventId_validate=852/wd:Response_Comment',
      '_eventId_add=850',
      '_eventId_cancel=Cancel',
    ]);
    const all = posts(transport);
    expect(all[3]!.get('852/wd:Response_Comment')).toBe('<p>Great &lt;work&gt;.</p>');
    expect(all[4]!.get('850')).toBe('16411$2');
    expect(all.some((p) => p.get('931') === '934$20')).toBe(false);
  });

  it('applies on a fresh flow: same steps, then Submit and the commit, no cancel', async () => {
    const { client, transport } = makeClient(giveRoutes());
    vi.spyOn(client, 'getFeedback').mockResolvedValue({
      matched: 'Feedback Given',
      feedback: [{ To: 'Pat Doe', Feedback: 'Great <work>.' }],
    });
    const plan = await client.planGiveFeedback({ to: 'Pat Doe', feedback: 'Great <work>.' });
    transport.calls.length = 0;
    const r = await client.applyGiveFeedback(plan);
    expect(events(transport)).toEqual([
      '_eventId_prompt=66',
      '_eventId_add=66',
      '_eventId_submit=72',
      '_eventId_validate=852/wd:Response_Comment',
      '_eventId_add=931',
      '_eventId_submit=944',
    ]);
    expect(posts(transport)[4]!.get('931')).toBe('934$20');
    expect(r).toMatchObject({ action: 'give', to: 'Pat Doe', verified: true });
    expect(client.getFeedback).toHaveBeenCalledWith('247$1', 'given');
  });

  it('refuses to submit when the recipient now resolves differently', async () => {
    const routes = giveRoutes();
    const { client, transport } = makeClient(routes);
    const plan = await client.planGiveFeedback({ to: 'Pat Doe', feedback: 'Thanks' });
    (routes as Record<string, unknown>)['POST /acme/prompt/c0/66.htmld'] = {
      items: [{ instanceId: '247$99', text: 'Pat Doe' }],
    };
    transport.calls.length = 0;
    await expect(client.applyGiveFeedback(plan)).rejects.toThrow(/changed since the preview/);
    expect(events(transport)).not.toContain('_eventId_submit=944');
    expect(events(transport).at(-1)).toBe('_eventId_cancel=Cancel');
  });

  it('stops before Submit when Workday does not acknowledge a step', async () => {
    const { client, transport } = makeClient(giveRoutes({ badStep: '850' }));
    await expect(client.planGiveFeedback({ to: 'Pat Doe', feedback: 'x', badge: 'own it' })).rejects.toThrow(/Nope\./);
    expect(events(transport).at(-1)).toBe('_eventId_cancel=Cancel');
  });

  it('names the badges when the one asked for does not exist', async () => {
    const { client } = makeClient(giveRoutes());
    await expect(client.planGiveFeedback({ to: 'Pat Doe', feedback: 'x', badge: 'teamwork' })).rejects.toThrow(
      /I own it/
    );
  });

  it('lists the people when the name is ambiguous', async () => {
    const { client } = makeClient(
      giveRoutes({
        people: [
          { instanceId: '247$7', text: 'Pat Doe' },
          { instanceId: '247$8', text: 'Pat Doering' },
        ],
      })
    );
    await expect(client.planGiveFeedback({ to: 'Pat Do', feedback: 'x' })).rejects.toThrow(/Pat Doe.*Pat Doering/s);
  });

  it('reports a form sent back on Submit as not given', async () => {
    const { client } = makeClient(giveRoutes({ commit: giveForm }));
    const plan = await client.planGiveFeedback({ to: 'Pat Doe', feedback: 'x' });
    await expect(client.applyGiveFeedback(plan)).rejects.toThrow(/sent the form back/);
  });

  it('never returns the session token or flow key', async () => {
    const { client } = makeClient(giveRoutes());
    const plan = await client.planGiveFeedback({ to: 'Pat Doe', feedback: 'x' });
    expect(JSON.stringify(plan.preview)).not.toMatch(/SECRET-TOKEN|e5s1|e5s2/);
  });
});

function requestRoutes(opts: { about?: boolean } = {}) {
  let row = 2000;
  return {
    '/acme/task/2997$3241.htmld': requestForm,
    '/acme/task/2997$2976.htmld': associatePrompt,
    'POST /acme/prompt/c0/66.htmld': { items: [{ instanceId: '247$7', text: 'Pat Doe' }] },
    'POST /acme/prompt/c3/948.htmld': (init: FetchInit) => {
      const q = new URLSearchParams(init.body).get('q');
      return { items: [{ instanceId: q === 'Sam Roe' ? '247$11' : '247$12', text: q }] };
    },
    'POST /acme/prompt/c3/949.htmld': { items: [{ instanceId: '12503$1', text: 'Feedback on Me' }] },
    [FLOW]: (init: FetchInit) => {
      const p = new URLSearchParams(init.body);
      if (p.get('_eventId_submit') === '72') return opts.about ? requestForm : {};
      if (p.get('_eventId_submit') === '1051') return done;
      if (p.has('_eventId_cancel')) return {};
      if (p.get('_eventId_add') === '949') return templateChosen;
      if (p.get('_eventId_add') === '956.217') return questionRowAdded(String(row++));
      if (p.get('_eventId_add') === '66') return {};
      return ok;
    },
  };
}

describe('WorkdayClient — request feedback', () => {
  it('plans a request on yourself: recipients, template, extra question; then cancels', async () => {
    const { client, transport } = makeClient(requestRoutes());
    const plan = await client.planRequestFeedback({
      from: ['Sam Roe', 'Lee Poe'],
      template: 'feedback on me',
      questions: ['How did the Q3 launch go?'],
    });
    expect(plan.preview).toEqual({
      action: 'request',
      about: 'yourself',
      from: ['Sam Roe', 'Lee Poe'],
      template: 'Feedback on Me',
      questions: [
        'Please provide me feedback on what I can do differently?',
        'What did I do well?',
        'How did the Q3 launch go?',
      ],
      visibility: ['Not anonymous', 'Shared: Share with others'],
    });
    expect(events(transport)).toEqual([
      '_eventId_prompt=948',
      '_eventId_add=948',
      '_eventId_prompt=948',
      '_eventId_add=948',
      '_eventId_prompt=949',
      '_eventId_add=949',
      '_eventId_add=956.217',
      '_eventId_validate=2000/wd:Feedback_Question',
      '_eventId_cancel=Cancel',
    ]);
    expect(posts(transport)[7]!.get('2000/wd:Feedback_Question')).toBe('<p>How did the Q3 launch go?</p>');
  });

  it('opens the associate form through its prompt for a request about a report', async () => {
    const { client, transport } = makeClient(requestRoutes({ about: true }));
    const plan = await client.planRequestFeedback({ about: 'Pat Doe', from: ['Sam Roe'], questions: ['Q?'] });
    expect(plan.preview.about).toBe('Pat Doe');
    expect(events(transport).slice(0, 3)).toEqual(['_eventId_prompt=66', '_eventId_add=66', '_eventId_submit=72']);
  });

  it('applies with Submit and verifies against Feedback Requested', async () => {
    const { client, transport } = makeClient(requestRoutes());
    vi.spyOn(client, 'getFeedback').mockResolvedValue({
      matched: 'Feedback Requested',
      feedback: [{ 'Requested From': 'Sam Roe', Question: 'Q?' }],
    });
    const plan = await client.planRequestFeedback({ from: ['Sam Roe'], questions: ['Q?'] });
    transport.calls.length = 0;
    const r = await client.applyRequestFeedback(plan);
    expect(events(transport).slice(-2)).toEqual(['_eventId_add=1035', '_eventId_submit=1051']);
    expect(r).toMatchObject({ action: 'request', verified: true });
    expect(client.getFeedback).toHaveBeenCalledWith('247$1', 'requested');
  });

  it('says it could not confirm when the re-read does not show the request', async () => {
    const { client } = makeClient(requestRoutes());
    vi.spyOn(client, 'getFeedback').mockResolvedValue({ matched: 'Feedback Requested', feedback: [] });
    const plan = await client.planRequestFeedback({ from: ['Sam Roe'], questions: ['Q?'] });
    const r = await client.applyRequestFeedback(plan);
    expect(r.verified).toBe(false);
    expect(r.verification).toMatch(/could not find/i);
  });

  it('needs at least one question or a template', async () => {
    const { client, transport } = makeClient(requestRoutes());
    await expect(client.planRequestFeedback({ from: ['Sam Roe'] })).rejects.toThrow(/question or a template/);
    expect(transport.calls).toHaveLength(0);
  });

  it('needs someone to ask', async () => {
    const { client } = makeClient(requestRoutes());
    await expect(client.planRequestFeedback({ from: [], questions: ['Q?'] })).rejects.toThrow(/who to ask/);
  });
});
