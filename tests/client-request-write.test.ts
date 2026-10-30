import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';

// Revising a request: the "Revise Request" inbox task opens the request's
// questionnaire with its saved answers and a Submit / Save for Later bar.
// Protocol captured live 2026-10 from the web app (values invented):
//   text answer   → _eventId_validate=<fieldId>, <fieldId>=<text>
//   choice answer → _eventId_add=<fieldId>, <fieldId>=<optionIid>, <iid>_DID/_IID/_PV/_V
//   the action    → _eventId_add=<barId>, <barId>=<buttonIid>, <iid>_DID, <iid>_IID
//   commit        → _eventId_submit=<pageId>

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

const fresh = JSON.parse(readFileSync(new URL('./fixtures/request-form.json', import.meta.url), 'utf8'));

/** A Revise Request page with the given saved answers. */
function revisePage(answers: { id?: string; supports?: 'Yes' | 'No'; impact?: string }) {
  const page = JSON.parse(JSON.stringify(fresh));
  page.title = { widget: 'titleStaticText', text: 'Revise Request' };
  page.sessionSecureToken = 'TOKEN-123';
  const panels = page.body.children[3].children[2].panels;
  if (answers.id !== undefined) panels[0].children[1].value = answers.id;
  if (answers.supports) panels[1].children[4].selectedIds = [answers.supports === 'Yes' ? '1236.1226' : '1236.1227'];
  if (answers.impact !== undefined) panels[2].children[1].value = answers.impact;
  return page;
}

const bootConfig = { appRoot: JSON.stringify({ sessionSecureToken: 'INBOX-TOKEN' }) };
const INBOX = '/acme/internalapi/internalapi/inbox/v2/acme/inboxItems?category=Actions&offset=0&limit=100';
const reviseItem = (iid: string, created: string) => ({
  relatedItem: {
    title: 'Request Process: 2026 Example Request Form: Me',
    createdDate: created,
    itemType: { descriptor: 'Request' },
  },
  taskToExecute: { label: 'Revise Request', uri: `/acme/d/inst/${iid}/rel-task/2997$12874.htmld` },
  relatedTasks: [],
});
const inbox = (...iids: string[]) => ({
  total: iids.length,
  data: iids.map((iid, i) => reviseItem(iid, `2026-10-30T18:0${i}:00.000Z`)),
});

const REQ = '/acme/inst/20447$1/rel-task/2997$12874.htmld';
const FLOW = '/acme/flowController.htmld';

function makeClient(opts: { pages?: unknown[]; inboxAfter?: unknown; flow?: (p: URLSearchParams) => unknown } = {}) {
  const pages = opts.pages ?? [revisePage({ id: '000101', supports: 'Yes' })];
  let reads = 0;
  let submitted = false;
  const transport = new RoutingTransport({
    '/acme/boot-config': bootConfig,
    [INBOX]: () => (submitted && opts.inboxAfter ? opts.inboxAfter : inbox('20447$1', '20447$2')),
    [`GET ${REQ}`]: () => pages[Math.min(reads++, pages.length - 1)],
    [`POST ${FLOW}`]: (init: FetchInit) => {
      const p = new URLSearchParams(init.body);
      const custom = opts.flow?.(p);
      if (custom !== undefined) return custom;
      if (p.has('_eventId_submit')) {
        submitted = true;
        return { widget: 'root', title: { widget: 'titleStaticText', text: 'Up Next' }, body: { widget: 'vbox' } };
      }
      return { widget: 'changeSummary', changes: [] };
    },
  });
  return { client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }), transport };
}

const posts = (t: RoutingTransport) =>
  t.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body));

describe('WorkdayClient.listOpenRequests / getRequest', () => {
  it('lists the requests waiting for you to revise, by id', async () => {
    const { client } = makeClient();
    expect(await client.listOpenRequests()).toEqual([
      { request: '20447$1', title: 'Request Process: 2026 Example Request Form: Me', created: '2026-10-30T18:00:00.000Z' },
      { request: '20447$2', title: 'Request Process: 2026 Example Request Form: Me', created: '2026-10-30T18:01:00.000Z' },
    ]);
  });

  it('reads one request\'s questions with their saved answers', async () => {
    const { client, transport } = makeClient();
    const req = await client.getRequest('20447$1');
    expect(req.request).toBe('20447$1');
    expect(req.questions.map((q) => [q.number, q.question, q.answer])).toEqual([
      [1, 'Numerical Employee ID number', '000101'],
      [2, 'My manager supports this promotion', 'Yes'],
      [3, 'Organization Impact', undefined],
    ]);
    expect(transport.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('names the open requests when the id is unknown', async () => {
    const { client } = makeClient();
    await expect(client.getRequest('99$9')).rejects.toThrow(/20447\$1.*20447\$2/s);
  });
});

describe('WorkdayClient.planRequestUpdate', () => {
  it('diffs the answers against a fresh read, by question number or text', async () => {
    const { client, transport } = makeClient();
    const plan = await client.planRequestUpdate('20447$1', { '3': 'Leads 4 engineers', 'manager supports': 'No' }, 'save');
    expect(plan.preview).toEqual({
      request: '20447$1',
      action: 'save',
      changes: [
        { number: 2, question: 'My manager supports this promotion', from: 'Yes', to: 'No' },
        { number: 3, question: 'Organization Impact', from: null, to: 'Leads 4 engineers' },
      ],
    });
    expect(plan.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(transport.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('drops answers that equal what is already saved', async () => {
    const { client } = makeClient();
    const plan = await client.planRequestUpdate('20447$1', { '1': '000101', '3': 'New' }, 'save');
    expect(plan.preview.changes.map((c) => c.number)).toEqual([3]);
  });

  it('rotates the revision when the saved answers change', async () => {
    const a = await makeClient().client.planRequestUpdate('20447$1', {}, 'submit');
    const b = await makeClient({ pages: [revisePage({ id: '000999', supports: 'Yes' })] }).client.planRequestUpdate(
      '20447$1',
      {},
      'submit'
    );
    expect(a.revision).not.toBe(b.revision);
  });

  it('refuses an option that is not offered', async () => {
    const { client } = makeClient();
    await expect(client.planRequestUpdate('20447$1', { '2': 'Maybe' }, 'save')).rejects.toThrow(/Yes.*No/s);
  });

  it('refuses an unknown or ambiguous question', async () => {
    const { client } = makeClient();
    await expect(client.planRequestUpdate('20447$1', { 'salary': 'x' }, 'save')).rejects.toThrow(/No question matching/);
    await expect(client.planRequestUpdate('20447$1', { '9': 'x' }, 'save')).rejects.toThrow(/No question 9/);
  });

  it('refuses to submit with a required question unanswered', async () => {
    const { client } = makeClient({ pages: [revisePage({ supports: 'Yes' })] });
    await expect(client.planRequestUpdate('20447$1', {}, 'submit')).rejects.toThrow(/Numerical Employee ID number/);
  });

  it('refuses a save that changes nothing', async () => {
    const { client } = makeClient();
    await expect(client.planRequestUpdate('20447$1', { '1': '000101' }, 'save')).rejects.toThrow(/nothing to save/i);
  });
});

describe('WorkdayClient.applyRequestUpdate', () => {
  it('posts each change, then the button, then commits — on the flow it just read', async () => {
    const { client, transport } = makeClient({
      pages: [revisePage({ id: '000101', supports: 'Yes' }), revisePage({ id: '000101', supports: 'No', impact: 'Leads 4' })],
    });
    const plan = await client.planRequestUpdate('20447$1', { '2': 'No', '3': 'Leads 4' }, 'save');
    const result = await client.applyRequestUpdate(plan);
    const p = posts(transport);
    expect(p.map((x) => [...x.keys()].find((k) => k.startsWith('_eventId_')))).toEqual([
      '_eventId_add',
      '_eventId_validate',
      '_eventId_add',
      '_eventId_submit',
    ]);
    expect(p[0].get('1236')).toBe('11431$685');
    expect(p[0].get('11431$685_DID')).toBe('No');
    expect(p[1].get('_eventId_validate')).toBe('1365/wd:Answer_Text');
    expect(p[1].get('1365/wd:Answer_Text')).toBe('Leads 4');
    expect(p[2].get('1561')).toBe('934$14'); // Save for Later
    expect(p[3].get('_eventId_submit')).toBe('1579');
    expect(p.every((x) => x.get('_flowExecutionKey') === 'e1s1')).toBe(true);
    expect(result).toMatchObject({ action: 'save', verified: true });
  });

  it('presses Submit for a submit, and verifies the request left your inbox', async () => {
    const { client, transport } = makeClient({ inboxAfter: inbox('20447$2') });
    const plan = await client.planRequestUpdate('20447$1', {}, 'submit');
    const result = await client.applyRequestUpdate(plan);
    expect(posts(transport).find((x) => x.has('1561'))?.get('1561')).toBe('934$20');
    expect(result).toMatchObject({ action: 'submit', verified: true });
  });

  it('reports a save whose re-read does not show the new answers as unverified', async () => {
    const { client } = makeClient({ pages: [revisePage({ id: '000101', supports: 'Yes' })] });
    const plan = await client.planRequestUpdate('20447$1', { '3': 'Leads 4' }, 'save');
    const result = await client.applyRequestUpdate(plan);
    expect(result.verified).toBe(false);
  });

  it('stops before committing when Workday rejects a change', async () => {
    const { client, transport } = makeClient({
      flow: (p) => (p.has('_eventId_validate') ? '<?xml version="1.0"?><wml:System_Error/>' : undefined),
    });
    const plan = await client.planRequestUpdate('20447$1', { '3': 'Leads 4' }, 'save');
    await expect(client.applyRequestUpdate(plan)).rejects.toThrow(/nothing was saved|not committed/i);
    expect(posts(transport).some((x) => x.has('_eventId_submit'))).toBe(false);
  });

  it('never retries a write after a timeout', async () => {
    const { client, transport } = makeClient({ inboxAfter: inbox('20447$2') });
    await client.applyRequestUpdate(await client.planRequestUpdate('20447$1', {}, 'submit'));
    expect(transport.calls.filter((c) => c.method === 'POST').every((c) => !c.retryOnTimeout)).toBe(true);
  });
});
