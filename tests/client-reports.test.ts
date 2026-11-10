import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';
import { promptPage, dashboardTab } from './reports-fixtures.js';

// Shapes mirror a production tenant captured live in 2026-11. Values are
// invented; structure is faithful.

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
      body:
        hit === undefined
          ? 'not found'
          : typeof hit === 'object' && hit !== null && '__raw' in hit
            ? String((hit as { __raw: string }).__raw)
            : JSON.stringify(hit),
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

const resultGrid = (rows: Array<[string, string]>, deep = rows.length) => ({
  widget: 'grid',
  rowCount: rows.length,
  deepRowCount: deep,
  chunkingUrl: '/acme/chunkablegrid/c7/3499.960',
  columns: [
    { widget: 'column', columnId: '960.1', label: 'Position Number' },
    { widget: 'column', columnId: '960.2', label: 'Worker' },
    { widget: 'column', columnId: '960.3', label: 'Always Empty' },
  ],
  rows: rows.map(([pos, worker]) => ({
    widget: 'row',
    cellsMap: {
      '960.1': { widget: 'text', value: pos },
      '960.2': { widget: 'monikerList', instances: [{ widget: 'moniker', text: worker, instanceId: '247$1' }] },
    },
  })),
});

const resultPage = (rows: Array<[string, string]>, deep?: number) => ({
  widget: 'root',
  tenant: 'acme',
  title: { widget: 'titleMonikerList', text: 'Position Report' },
  sessionSecureToken: 'SECRET-TOKEN',
  body: { widget: 'vbox', children: [{ widget: 'stylizedHeader' }, resultGrid(rows, deep)] },
});

const errorPage = {
  widget: 'root',
  sessionSecureToken: 'SECRET-TOKEN',
  unassociatedErrorNodes: [
    {
      widget: 'error',
      nodeId: '174',
      message: 'The entered information does not meet the restrictions defined for this field.',
      type: 'ERROR',
    },
  ],
};

const FLOW = 'POST /acme/flowController.htmld';

function posts(t: RoutingTransport): URLSearchParams[] {
  return t.calls.filter((c) => c.method === 'POST').map((c) => new URLSearchParams(c.body));
}
function events(t: RoutingTransport): string[] {
  return posts(t).map((p) => [...p.keys()].find((k) => k.startsWith('_eventId_')) ?? '?');
}

function makeClient(routes: Record<string, Route>) {
  const transport = new RoutingTransport(routes);
  return { client: new WorkdayClient({ transport, tenant: 'acme' }), transport };
}

function promptRoutes(opts: { submit?: unknown; items?: Array<{ instanceId: string; text: string }> } = {}) {
  return {
    '/acme/task/1422$242.htmld': promptPage,
    'POST /acme/prompt/c6/174.htmld': {
      items: opts.items ?? [
        { instanceId: '2500$10', text: 'VFS Operations (Pat Doe)' },
        { instanceId: '2500$11', text: 'VFS Operations Support (Sam Roe)' },
      ],
    },
    [FLOW]: (init: FetchInit) => {
      const p = new URLSearchParams(init.body);
      if (p.has('_eventId_submit')) return opts.submit ?? resultPage([['10037006', 'Alex Smith']]);
      return {};
    },
  };
}

describe('WorkdayClient.runReport — a report that runs on GET', () => {
  it('returns its table keyed by column, without empty columns or a flow', async () => {
    const { client, transport } = makeClient({
      '/acme/task/1422$10039.htmld': resultPage([
        ['1', 'Alex Smith'],
        ['2', 'Jo Bloggs'],
      ]),
    });
    const r = await client.runReport('1422$10039');
    expect(r.report).toBe('Position Report');
    expect(r.tables).toEqual([
      {
        columns: ['Position Number', 'Worker'],
        rows: [
          { 'Position Number': '1', Worker: 'Alex Smith' },
          { 'Position Number': '2', Worker: 'Jo Bloggs' },
        ],
      },
    ]);
    expect(transport.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('accepts the address-bar URL of the report', async () => {
    const { client } = makeClient({ '/acme/task/1422$10039.htmld': resultPage([['1', 'A']]) });
    const r = await client.runReport('https://wd5.myworkday.com/acme/d/task/1422$10039.htmld#TABINDEX=0');
    expect(r.tables[0]!.rows).toHaveLength(1);
  });

  it('says when Workday holds more rows than it returned', async () => {
    const { client } = makeClient({ '/acme/task/1422$10039.htmld': resultPage([['1', 'A']], 40) });
    const r = await client.runReport('1422$10039');
    expect(r.tables[0]!.incomplete).toEqual({ shown: 1, total: 40 });
  });

  it('caps the rows it returns at `limit`', async () => {
    const { client } = makeClient({
      '/acme/task/1422$10039.htmld': resultPage([
        ['1', 'A'],
        ['2', 'B'],
        ['3', 'C'],
      ]),
    });
    const r = await client.runReport('1422$10039', { limit: 2 });
    expect(r.tables[0]!.rows).toHaveLength(2);
    expect(r.tables[0]!.incomplete).toEqual({ shown: 2, total: 3 });
  });

  it('refuses prompts for a report that takes none', async () => {
    const { client } = makeClient({ '/acme/task/1422$10039.htmld': resultPage([['1', 'A']]) });
    await expect(client.runReport('1422$10039', { prompts: { Org: 'x' } })).rejects.toThrow(/takes no prompts/);
  });
});

describe('WorkdayClient.runReport — a report behind a prompt form', () => {
  it('runs it with its defaults: OK, then cancel, on the page\'s own flow', async () => {
    const { client, transport } = makeClient(promptRoutes());
    const r = await client.runReport('1422$242');
    expect(events(transport)).toEqual(['_eventId_submit', '_eventId_cancel']);
    expect(posts(transport)[0]!.get('_eventId_submit')).toBe('189');
    expect(posts(transport).every((p) => p.get('_flowExecutionKey') === 'e1s1')).toBe(true);
    expect(r.tables[0]!.rows).toEqual([{ 'Position Number': '10037006', Worker: 'Alex Smith' }]);
    expect(r.prompts).toEqual([
      { label: 'Staffing Status', values: ['Filled', 'Open'] },
      { label: 'Supervisory Organization', values: ['Executive - CEO (Top Boss)'] },
      { label: 'Include Subordinate Organizations', values: ['true'] },
    ]);
  });

  it('replaces a list prompt\'s defaults: remove, search, add, then OK', async () => {
    const { client, transport } = makeClient(promptRoutes());
    const r = await client.runReport('1422$242', { prompts: { 'supervisory org': 'VFS Operations (Pat Doe)' } });
    expect(events(transport)).toEqual([
      '_eventId_remove',
      '_eventId_prompt',
      '_eventId_add',
      '_eventId_submit',
      '_eventId_cancel',
    ]);
    const [remove, search, add] = posts(transport);
    expect(remove!.get('_eventId_remove')).toBe('174');
    expect(remove!.get('174')).toBe('2500$1');
    expect(search!.get('q')).toBe('VFS Operations (Pat Doe)');
    expect(add!.get('174')).toBe('2500$10');
    expect(add!.get('2500$10_DID')).toBe('VFS Operations (Pat Doe)');
    expect(add!.get('2500$10_IID')).toBe('2500$10');
    expect(r.prompts).toContainEqual({ label: 'Supervisory Organization', values: ['VFS Operations (Pat Doe)'] });
  });

  it('adds every value of a multi-value prompt', async () => {
    const { client, transport } = makeClient({
      ...promptRoutes(),
      'POST /acme/prompt/c6/180.htmld': (init: FetchInit) => {
        const q = new URLSearchParams(init.body).get('q');
        return { items: [{ instanceId: q === 'Open' ? '4477$4' : '4477$1', text: q }] };
      },
    });
    await client.runReport('1422$242', { prompts: { 'Staffing Status': ['Open', 'Frozen'] } });
    expect(events(transport)).toEqual([
      '_eventId_remove',
      '_eventId_remove',
      '_eventId_prompt',
      '_eventId_add',
      '_eventId_prompt',
      '_eventId_add',
      '_eventId_submit',
      '_eventId_cancel',
    ]);
  });

  it('names the options when a value is ambiguous, and cancels without running', async () => {
    const { client, transport } = makeClient(promptRoutes());
    await expect(
      client.runReport('1422$242', { prompts: { 'Supervisory Organization': 'VFS Operations' } })
    ).rejects.toThrow(/Pat Doe.*Sam Roe/s);
    expect(events(transport)).not.toContain('_eventId_submit');
    expect(events(transport).at(-1)).toBe('_eventId_cancel');
  });

  it('says so when no option matches', async () => {
    const { client } = makeClient(promptRoutes({ items: [] }));
    await expect(
      client.runReport('1422$242', { prompts: { 'Supervisory Organization': 'Nowhere' } })
    ).rejects.toThrow(/No "Supervisory Organization" option matching "Nowhere"/);
  });

  it('names the prompts when a prompt label is unknown', async () => {
    const { client } = makeClient(promptRoutes());
    await expect(client.runReport('1422$242', { prompts: { Planet: 'Mars' } })).rejects.toThrow(
      /Supervisory Organization/
    );
  });

  it('refuses a prompt type it cannot set rather than guessing', async () => {
    const { client, transport } = makeClient(promptRoutes());
    await expect(
      client.runReport('1422$242', { prompts: { 'Effective as of Date and Time': '2026-01-01' } })
    ).rejects.toThrow(/dateInput/);
    expect(events(transport)).not.toContain('_eventId_submit');
  });

  it('reports Workday\'s validation errors by prompt, with the values it tried', async () => {
    const { client, transport } = makeClient(promptRoutes({ submit: errorPage }));
    const err = await client.runReport('1422$242').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Supervisory Organization: The entered information does not meet/);
    expect((err as Error).message).toMatch(/Executive - CEO \(Top Boss\)/);
    expect(events(transport).at(-1)).toBe('_eventId_cancel');
  });

  it('refuses a business-process form: a Submit bar means this is not a report', async () => {
    const { client, transport } = makeClient({
      ...promptRoutes(),
      '/acme/task/1422$242.htmld': {
        ...promptPage,
        body: { ...promptPage.body, children: [...promptPage.body.children, { widget: 'bpfButtonBar' }] },
      },
    });
    await expect(client.runReport('1422$242')).rejects.toThrow(/not a report/);
    expect(events(transport)).not.toContain('_eventId_submit');
  });

  it('refuses a result page that turns out to be a form, and cancels it', async () => {
    const { client, transport } = makeClient(
      promptRoutes({ submit: { widget: 'root', body: { widget: 'vbox', children: [{ widget: 'bpfButtonBar' }] } } })
    );
    await expect(client.runReport('1422$242')).rejects.toThrow(/not a report/);
    expect(events(transport).at(-1)).toBe('_eventId_cancel');
  });

  it('never returns the session token or flow key', async () => {
    const { client } = makeClient(promptRoutes());
    const r = await client.runReport('1422$242', { prompts: { 'Supervisory Organization': 'VFS Operations (Pat Doe)' } });
    expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN');
    expect(JSON.stringify(r)).not.toContain('e1s1');
  });

  it('never retries a flow POST after a timeout', async () => {
    const { client, transport } = makeClient(promptRoutes());
    await client.runReport('1422$242');
    expect(transport.calls.filter((c) => c.method === 'POST').every((c) => !c.retryOnTimeout)).toBe(true);
  });
});

const APPS_PATH = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
const apps = {
  widget: 'configuredApps',
  children: [
    { widget: 'configuredAppsItem', label: 'Open Positions Dashboard', taskIid: '12709$5' },
    { widget: 'configuredAppsItem', label: 'Year End Dashboard', taskIid: '23748$3' },
    { widget: 'configuredAppsItem', label: 'Benefits', taskIid: '2998$1' },
  ],
};
const dashGroup = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Year End Dashboard' },
  body: {
    widget: 'landingPageGroup',
    children: [{ widget: 'landingPageTab', label: 'Compensation', taskIid: '12709$31' }],
  },
};
const openPositions = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'Open Positions Dashboard' },
  body: {
    widget: 'landingPage',
    children: [{ widget: 'landingPageWorklet', label: 'Open Reqs', taskIid: '3001$26', workletIid: '1422$77' }],
  },
};

function dashRoutes(extra: Record<string, Route> = {}) {
  return {
    [APPS_PATH]: apps,
    '/acme/task/23748$3.htmld': dashGroup,
    '/acme/task/12709$31.htmld': dashboardTab,
    '/acme/task/12709$5.htmld': openPositions,
    ...extra,
  };
}

describe('WorkdayClient.getDashboard', () => {
  it('resolves a dashboard app by label and lists each tab\'s worklets and report links', async () => {
    const { client } = makeClient(dashRoutes());
    const d = await client.getDashboard('year end');
    expect(d.dashboard).toBe('Year End Dashboard');
    expect(d.tabs).toEqual([
      {
        label: 'Compensation',
        worklets: [
          { label: 'Increase Summary by Performance Rating', reportId: '1422$6224' },
          { label: 'Budget Utilization', reportId: '1422$3981' },
        ],
        links: [
          { section: 'Links to Reports', label: 'Compensation Review Process View Organization', reportId: '2997$10377' },
          { section: 'Links to Reports', label: 'Budget Report by Country', reportId: '1422$6216' },
        ],
      },
    ]);
  });

  it('treats a dashboard without tabs as one tab', async () => {
    const { client } = makeClient(dashRoutes());
    const d = await client.getDashboard('open positions');
    expect(d.tabs).toEqual([
      { label: 'Open Positions Dashboard', worklets: [{ label: 'Open Reqs', reportId: '1422$77' }], links: [] },
    ]);
  });

  it('runs every worklet when asked, keeping a failing one as an error', async () => {
    const { client } = makeClient(
      dashRoutes({
        '/acme/task/1422$6224.htmld': resultPage([['1', 'A']]),
      })
    );
    const d = await client.getDashboard('year end', { run: true });
    const [ok, failed] = d.tabs[0]!.worklets;
    expect(ok!.tables?.[0]!.rows).toEqual([{ 'Position Number': '1', Worker: 'A' }]);
    expect(failed!.error).toMatch(/404/);
  });

  it('reports a worklet\'s Workday System_Error by its message', async () => {
    const { client } = makeClient(
      dashRoutes({
        '/acme/task/1422$3981.htmld': {
          __raw:
            '<?xml version="1.0" encoding="UTF-8"?><wml:System_Error xmlns:wml="http://www.workday.com/ns/model/1.0" ' +
            'Type="x"><wml:Message>The entered information does not meet the restrictions defined for this ' +
            'field. (In Progress Compensation Review Event).</wml:Message></wml:System_Error>',
        },
      })
    );
    const d = await client.getDashboard('year end', { run: true });
    expect(d.tabs[0]!.worklets[1]!.error).toBe(
      'Workday refused /acme/task/1422$3981.htmld: The entered information does not meet the restrictions ' +
        'defined for this field. (In Progress Compensation Review Event).'
    );
  });

  it('never runs a worklet unless asked', async () => {
    const { client, transport } = makeClient(dashRoutes());
    await client.getDashboard('year end');
    expect(transport.calls.some((c) => c.path.includes('1422$'))).toBe(false);
  });

  it('names the dashboards when none matches', async () => {
    const { client } = makeClient(dashRoutes());
    await expect(client.getDashboard('nope')).rejects.toThrow(/Year End Dashboard/);
  });
});

describe('WorkdayClient.runReport — by name', () => {
  it('finds a report among your dashboards\' worklets and links', async () => {
    const { client } = makeClient(
      dashRoutes({ '/acme/task/1422$6216.htmld': resultPage([['9', 'Z']]) })
    );
    const r = await client.runReport('budget report by country');
    expect(r.reportId).toBe('1422$6216');
    expect(r.tables[0]!.rows).toEqual([{ 'Position Number': '9', Worker: 'Z' }]);
  });

  it('explains how to name a report it cannot find', async () => {
    const { client } = makeClient(dashRoutes());
    await expect(client.runReport('TU Position Management')).rejects.toThrow(/task id|address bar/i);
  });
});
