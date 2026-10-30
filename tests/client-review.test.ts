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

// Shapes mirror a production tenant captured live in 2026-10 (review and
// promotion season). Values are invented; structure is faithful.

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

const APPS_PATH = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
const apps = {
  widget: 'configuredApps',
  sessionSecureToken: 'TOKEN-123',
  children: [{ widget: 'configuredAppsItem', label: 'Org Chart', taskIid: '2998$2673' }],
};
const orgChart = {
  widget: 'root',
  title: 'Org Chart',
  body: {
    widget: 'hierarchyNavigator',
    workerIid: '247$100',
    ancestors: [
      {
        widget: 'navigatorDetail',
        navigatorInstance: {
          widget: 'navigatorList',
          selfUriTemplate: '/acme/inst/1$715/247$9',
          instances: [{ widget: 'moniker', text: 'Top Boss', instanceId: '247$9' }],
        },
      },
    ],
  },
};

const grid = (label: string, columns: string[], rows: Array<Record<string, unknown>>) => ({
  widget: 'grid',
  label,
  rowCount: rows.length,
  deepRowCount: rows.length,
  columns: columns.map((c, i) => ({ widget: 'column', columnId: `c${i}`, label: c })),
  // Live cells carry their column name as `label` — which is what made a
  // naive "label contains Organization" match pick the "Organization Role"
  // column over the "Organization" one.
  rows: rows.map((cells) => ({
    widget: 'row',
    cellsMap: Object.fromEntries(
      columns
        .map((c, i) => [`c${i}`, cells[c] ? { label: c, ...(cells[c] as object) } : undefined])
        .filter(([, v]) => v)
    ),
  })),
});
const text = (value: string) => ({ widget: 'text', value });
const monikers = (template: string, ...items: Array<[string, string]>) => ({
  widget: 'monikerList',
  selfUriTemplate: template,
  instances: items.map(([t, id]) => ({ widget: 'moniker', text: t, instanceId: id })),
});
const profile = (title: string, sections: Record<string, Record<string, string>>) => ({
  widget: 'root',
  title: { widget: 'titleStaticText', text: title },
  body: {
    widget: 'compositeView',
    children: Object.entries(sections).map(([label, tasks]) => ({
      widget: 'compositeViewSection',
      label,
      taskNodes: Object.entries(tasks).map(([l, uri]) => ({ widget: 'compositeViewTask', label: l, uri })),
    })),
  },
});

const ME = '/acme/inst/1$715/247$100.htmld';
const myProfile = profile('View Associate', {
  Job: { 'Job Details': '/acme/inst/1508$1/rel-task/2998$6445', Organizations: '/acme/inst/1508$1/rel-task/2998$6288' },
});
const myOrgs = {
  widget: 'root',
  title: 'Organizations',
  body: {
    widget: 'vbox',
    children: [
      grid('Member of These Organizations', ['Organization', 'Organization Type'], [
        { Organization: monikers('/acme/inst/15$1/2501$7', ['Acme LLC', '2501$7']), 'Organization Type': monikers('', ['Company', '224$5']) },
      ]),
      grid('Manager/Leader of These Organizations', ['Organization Role', 'Type', 'Organization'], [
        {
          'Organization Role': monikers('/acme/inst/15$153827/257$25', ['Manager', '257$25']),
          Type: monikers('', ['Supervisory', '224$3']),
          Organization: monikers('/acme/inst/15$382899/2500$10', ['Platform Ops (Me)', '2500$10']),
        },
        {
          Organization: monikers('/acme/inst/15$382899/2502$9', ['Cost Center 42', '2502$9']),
          Type: monikers('', ['Cost Center', '224$6']),
          'Organization Role': monikers('', ['Cost Center Manager', '257$9']),
        },
      ]),
    ],
  },
};
const orgPage = profile('View Supervisory Organization', {
  Overview: { Members: '/acme/inst/2500$10/rel-task/2998$9867', Details: '/acme/inst/2500$10/rel-task/2998$15499' },
});
const members = {
  widget: 'root',
  title: 'Organization Members',
  body: {
    widget: 'vbox',
    children: [
      grid('Members', ['Associate', 'Associate ID', 'Position', 'Location'], [
        {
          Associate: monikers('/acme/inst/15$17844/247$1', ['Pat Doe', '247$1']),
          'Associate ID': text('000101'),
          Position: monikers('', ['P1 Senior Engineer - Pat Doe', '1$1']),
          Location: monikers('', ['Remote', '216$1']),
        },
        {
          Associate: monikers('/acme/inst/15$17844/247$2', ['Sam Roe', '247$2']),
          'Associate ID': text('000102'),
        },
      ]),
    ],
  },
};

const PAT = '/acme/inst/15$17844/247$1.htmld';
const patProfile = profile('View Associate', {
  Performance: { 'Performance Reviews': '/acme/inst/247$1/rel-task/2998$6163', Goals: '/acme/inst/247$1/rel-task/2998$46677' },
  Feedback: {
    'View Feedback Received': '/acme/inst/247$1/rel-task/3005$4676',
    'Feedback Given': '/acme/inst/247$1/rel-task/3005$780',
  },
});
const reviewList = {
  widget: 'root',
  title: 'Performance Reviews for Employee - Profile View',
  body: {
    widget: 'vbox',
    children: [
      grid('Completed', ['Review', 'Review Period Start Date', 'Review Period End Date', 'Manager Rating', 'View Review', 'Create Review PDF'], [
        {
          Review: monikers('/acme/inst/1$2471/671$2', ['2026 Mid-Year Check In: Pat Doe', '671$2']),
          'Review Period Start Date': { widget: 'date', value: '01/01/2026' },
          'Review Period End Date': { widget: 'date', value: '05/31/2026' },
          'View Review': { widget: 'commandButton', label: 'View', uri: '/acme/inst/671$2/rel-task/2997$1498' },
          'Create Review PDF': { widget: 'commandButton', label: 'Create New PDF', uri: '/acme/button/c27/143/208' },
        },
        {
          Review: monikers('/acme/inst/1$2471/671$1', ['2025 Year-End Check In: Pat Doe', '671$1']),
          'Review Period Start Date': { widget: 'date', value: '01/01/2025' },
          'Review Period End Date': { widget: 'date', value: '12/31/2025' },
          'Manager Rating': monikers('', ['Performing', '672$70']),
          'View Review': { widget: 'commandButton', label: 'View', uri: '/acme/inst/671$1/rel-task/2997$1498' },
        },
      ]),
    ],
  },
};
const reviewWizard = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'View Printable Employee Review' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'taskWizard',
        children: [
          { widget: 'taskWizardSection', taskName: 'Values', uri: '/acme/task-wizard/c29/2998$37642/context/X' },
          { widget: 'taskWizardSection', taskName: 'Overall Performance', uri: '/acme/task-wizard/c29/2998$2/context/X' },
        ],
      },
      monikers('', ['Manager Evaluation: 2025 Year-End Check In: Pat Doe', '1007$1']),
    ],
  },
};
const valuesSection = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Values' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'panel',
        label: 'Manager Summary',
        children: [
          {
            widget: 'dropDownSelectList',
            label: 'Rating',
            selectedIds: ['o2'],
            instances: [
              { widget: 'dropDownSelectOption', text: 'Leading', id: 'o1' },
              { widget: 'dropDownSelectOption', text: 'Performing', id: 'o2' },
            ],
          },
          { widget: 'richTextAreaInput', label: 'Comment', value: '<p>Thinks like a customer.</p>' },
        ],
      },
      {
        widget: 'panel',
        label: 'Employee Summary',
        children: [{ widget: 'richTextAreaInput', label: 'Comment', value: '<p>I listen to users.</p>' }],
      },
    ],
  },
};
const overallSection = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Overall Performance' },
  body: { widget: 'vbox', children: [{ widget: 'richTextAreaInput', label: 'Comment', value: '<p>Solid year.</p>' }] },
};
const feedbackReceived = {
  widget: 'root',
  title: 'View Feedback Received',
  body: {
    widget: 'vbox',
    children: [
      grid('', ['Date', 'From', 'Feedback', 'Badge', 'Type'], [
        {
          Date: { widget: 'date', value: '08/13/2026' },
          From: text('Alex Kim'),
          Feedback: { widget: 'compactRichTextArea', value: '<p>Pat unblocked the release.</p>' },
          Badge: monikers('', ['I innovate and inspire', '16411$5']),
          Type: text('Anytime Feedback'),
        },
      ]),
    ],
  },
};

function makeClient(extra: Record<string, Route> = {}) {
  const transport = new RoutingTransport({
    [APPS_PATH]: apps,
    '/acme/task/2998$2673.htmld': orgChart,
    [ME]: myProfile,
    '/acme/inst/1508$1/rel-task/2998$6288.htmld': myOrgs,
    '/acme/inst/15$382899/2500$10.htmld': orgPage,
    '/acme/inst/2500$10/rel-task/2998$9867.htmld': members,
    [PAT]: patProfile,
    '/acme/inst/247$1/rel-task/2998$6163.htmld': reviewList,
    '/acme/inst/671$1/rel-task/2997$1498.htmld': reviewWizard,
    '/acme/inst/671$2/rel-task/2997$1498.htmld': { ...reviewWizard, body: { widget: 'vbox', children: [] } },
    '/acme/task-wizard/c29/2998$37642/context/X.htmld': valuesSection,
    '/acme/task-wizard/c29/2998$2/context/X.htmld': overallSection,
    '/acme/inst/247$1/rel-task/3005$4676.htmld': feedbackReceived,
    ...extra,
  });
  return { client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }), transport };
}

describe('WorkdayClient.getTeam', () => {
  it('walks your profile → the supervisory orgs you manage → their members', async () => {
    const { client } = makeClient();
    const team = await client.getTeam();
    expect(team.organizations).toHaveLength(1);
    const org = team.organizations[0];
    expect(org).toMatchObject({ name: 'Platform Ops (Me)', id: '2500$10' });
    expect(org.members).toEqual([
      {
        name: 'Pat Doe',
        workerId: '247$1',
        profileUri: PAT,
        details: {
          'Associate ID': '000101',
          Position: 'P1 Senior Engineer - Pat Doe',
          Location: 'Remote',
        },
      },
      {
        name: 'Sam Roe',
        workerId: '247$2',
        profileUri: '/acme/inst/15$17844/247$2.htmld',
        details: { 'Associate ID': '000102' },
      },
    ]);
  });

  it('skips orgs you lead that are not supervisory (cost centers etc.)', async () => {
    const { client, transport } = makeClient();
    await client.getTeam();
    expect(transport.calls.map((c) => c.path)).not.toContain('/acme/inst/15$382899/2502$9.htmld');
  });

  it('says so when you manage no supervisory organization', async () => {
    const { client } = makeClient({
      '/acme/inst/1508$1/rel-task/2998$6288.htmld': {
        ...myOrgs,
        body: { widget: 'vbox', children: [myOrgs.body.children[0]] },
      },
    });
    await expect(client.getTeam()).rejects.toThrow(/do not manage|no supervisory/i);
  });

  it('flags a members grid Workday paged, rather than passing off a partial team', async () => {
    const paged = JSON.parse(JSON.stringify(members));
    paged.body.children[0].deepRowCount = 40;
    const { client } = makeClient({ '/acme/inst/2500$10/rel-task/2998$9867.htmld': paged });
    const team = await client.getTeam();
    expect(team.organizations[0].incomplete).toEqual({ shown: 2, total: 40 });
  });
});

describe('WorkdayClient.getReviews', () => {
  it('lists a worker\'s reviews with period, rating and a view handle', async () => {
    const { client } = makeClient();
    const out = await client.getReviews(PAT);
    expect(out.reviews).toEqual([
      {
        review: '2026 Mid-Year Check In: Pat Doe',
        status: 'Completed',
        periodStart: '01/01/2026',
        periodEnd: '05/31/2026',
        viewUri: '/acme/inst/671$2/rel-task/2997$1498.htmld',
      },
      {
        review: '2025 Year-End Check In: Pat Doe',
        status: 'Completed',
        periodStart: '01/01/2025',
        periodEnd: '12/31/2025',
        rating: 'Performing',
        viewUri: '/acme/inst/671$1/rel-task/2997$1498.htmld',
      },
    ]);
  });

  it('opens one review by name and reads every section\'s ratings and comments', async () => {
    const { client } = makeClient();
    const review = await client.getReview(PAT, '2025 year-end');
    expect(review.review).toBe('2025 Year-End Check In: Pat Doe');
    expect(review.sections.map((s) => s.name)).toEqual(['Values', 'Overall Performance']);
    expect(review.sections[0].values).toEqual([
      { group: 'Manager Summary', label: 'Rating', value: 'Performing' },
      { group: 'Manager Summary', label: 'Comment', value: 'Thinks like a customer.' },
      { group: 'Employee Summary', label: 'Comment', value: 'I listen to users.' },
    ]);
  });

  it('opens the most recent review when asked for "latest"', async () => {
    const { client } = makeClient();
    const review = await client.getReview(PAT, 'latest');
    expect(review.review).toBe('2026 Mid-Year Check In: Pat Doe');
  });

  it('lists the reviews that exist when the name does not match', async () => {
    const { client } = makeClient();
    await expect(client.getReview(PAT, '2019')).rejects.toThrow(/2025 Year-End Check In/);
  });
});

describe('WorkdayClient.getFeedback', () => {
  it('reads feedback received as plain-text rows', async () => {
    const { client } = makeClient();
    const out = await client.getFeedback(PAT, 'received');
    expect(out.matched).toBe('View Feedback Received');
    expect(out.feedback).toEqual([
      {
        Date: '08/13/2026',
        From: 'Alex Kim',
        Feedback: 'Pat unblocked the release.',
        Badge: 'I innovate and inspire',
        Type: 'Anytime Feedback',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Request forms: Workday only renders a request's form inside a "Create
// Request" flow, so reading it means starting the flow and abandoning it.
// ---------------------------------------------------------------------------

const requestForm = JSON.parse(
  readFileSync(new URL('./fixtures/request-form.json', import.meta.url), 'utf8')
) as Record<string, unknown>;

const createRequestPrompt = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Create Request' },
  sessionSecureToken: 'TOKEN-123',
  flowExecutionKey: 'e9s1',
  promptUriTemplate: '/acme/prompt/[CONTEXT_ID]/[PROMPT_IID]',
  body: {
    widget: 'vbox',
    id: '72',
    children: [{ widget: 'monikerListInput', label: 'Request Type', required: true, contextId: 'c46', id: '66' }],
  },
};

const typeItems = (...names: string[]) => ({
  widget: 'prompt',
  items: names.map((text, i) => ({ instanceId: `20531$${i + 1}`, text, pv: true, v: true })),
});

function flowRoutes(opts: { items?: unknown; prompt?: unknown; form?: unknown } = {}): Record<string, Route> {
  return {
    'GET /acme/task/2997$12683.htmld': opts.prompt ?? createRequestPrompt,
    'POST /acme/prompt/c46/66.htmld': opts.items ?? typeItems('2026 Example Request Form'),
    'POST /acme/flowController.htmld': (init: FetchInit) => {
      const p = new URLSearchParams(init.body);
      if (p.has('_eventId_add')) return { widget: 'changeSummary', changes: [] };
      if (p.has('_eventId_submit')) return opts.form ?? requestForm;
      if (p.has('_eventId_cancel')) return { widget: 'cancel', command: { rel: 'redirect' } };
      return undefined;
    },
  };
}

const posts = (transport: RoutingTransport) =>
  transport.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body));

describe('WorkdayClient.getRequestForm', () => {
  it('opens the request type\'s form and returns its questions', async () => {
    const { client } = makeClient(flowRoutes());
    const form = await client.getRequestForm('example request');
    expect(form.requestType).toBe('2026 Example Request Form');
    expect(form.questions.map((q) => [q.question, q.required, q.answerType])).toEqual([
      ['Numerical Employee ID number', true, 'text'],
      ['My manager supports this promotion', true, 'choice'],
      ['Organization Impact', false, 'text'],
    ]);
  });

  it('drives exactly prompt → add → OK → cancel, in that order, on one flow', async () => {
    const { client, transport } = makeClient(flowRoutes());
    await client.getRequestForm('example request');
    const events = posts(transport).map((p) =>
      [...p.keys()].find((k) => k.startsWith('_eventId_'))
    );
    expect(events).toEqual(['_eventId_prompt', '_eventId_add', '_eventId_submit', '_eventId_cancel']);
    expect(posts(transport).every((p) => p.get('_flowExecutionKey') === 'e9s1')).toBe(true);
    const ok = posts(transport)[2];
    expect(ok.get('_eventId_submit')).toBe('72'); // the PROMPT page's OK, not the form's
    expect(posts(transport)[0].get('q')).toBe('example request');
    expect(posts(transport)[1].get('66')).toBe('20531$1');
  });

  it('never sends the form\'s Submit or Save for Later', async () => {
    const { client, transport } = makeClient(flowRoutes());
    await client.getRequestForm('example request');
    const bodies = transport.calls.filter((c) => c.method === 'POST').map((c) => c.body ?? '');
    for (const body of bodies) {
      expect(body).not.toContain('934%2420'); // Submit
      expect(body).not.toContain('934%2414'); // Save for Later
      expect(body).not.toContain('1561'); // the Submit/Save bar
    }
  });

  it('sends the session token to Workday but never returns it', async () => {
    const { client, transport } = makeClient(flowRoutes());
    const form = await client.getRequestForm('example request');
    const first = transport.calls.find((c) => c.method === 'POST');
    expect(new URLSearchParams(first?.body).get('sessionSecureToken')).toBe('TOKEN-123');
    expect(first?.headers?.['Session-Secure-Token']).toBe('TOKEN-123');
    expect(first?.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(JSON.stringify(form)).not.toContain('TOKEN-123');
    expect(JSON.stringify(form)).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('never retries a flow POST after a timeout', async () => {
    const { client, transport } = makeClient(flowRoutes());
    await client.getRequestForm('example request');
    expect(transport.calls.filter((c) => c.method === 'POST').every((c) => !c.retryOnTimeout)).toBe(true);
  });

  it('refuses to press OK on a page that already has a Submit bar', async () => {
    const { client, transport } = makeClient(flowRoutes({ prompt: { ...requestForm, flowExecutionKey: 'e9s1' } }));
    await expect(client.getRequestForm('example request')).rejects.toThrow(/Create Request/);
    expect(posts(transport).some((p) => p.has('_eventId_submit'))).toBe(false);
  });

  it('lists the matching types and cancels when the name is ambiguous', async () => {
    const { client, transport } = makeClient(
      flowRoutes({ items: typeItems('2026 Promotion Form (Managers)', '2026 Promotion Form (Directors)') })
    );
    await expect(client.getRequestForm('2026 promotion')).rejects.toThrow(/Managers.*Directors/s);
    const events = posts(transport).map((p) => [...p.keys()].find((k) => k.startsWith('_eventId_')));
    expect(events).toEqual(['_eventId_prompt', '_eventId_cancel']);
  });

  it('prefers an exact name over other partial matches', async () => {
    const { client } = makeClient(
      flowRoutes({ items: typeItems('2026 Example Request Form', '2026 Example Request Form (Leadership)') })
    );
    const form = await client.getRequestForm('2026 example request form');
    expect(form.requestType).toBe('2026 Example Request Form');
  });

  it('says what to try when no request type matches, and cancels', async () => {
    const { client, transport } = makeClient(flowRoutes({ items: typeItems() }));
    await expect(client.getRequestForm('nope')).rejects.toThrow(/No request type matching "nope"/);
    expect(posts(transport).at(-1)?.has('_eventId_cancel')).toBe(true);
  });

  it('cancels even when the form fails to load', async () => {
    const { client, transport } = makeClient(flowRoutes({ form: { widget: 'root', body: { widget: 'vbox' } } }));
    await expect(client.getRequestForm('example request')).rejects.toThrow(/questionnaire/i);
    expect(posts(transport).at(-1)?.has('_eventId_cancel')).toBe(true);
  });
});
