import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';

// Shapes captured live from a production tenant (2026-10). Values invented.

class RoutingTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  constructor(private routes: Record<string, unknown>) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const hit = this.routes[init.path];
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

const APPS = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
const apps = {
  widget: 'configuredApps',
  children: [{ widget: 'configuredAppsItem', label: 'My Team Management', taskIid: '14860$62' }],
};
// The hub: worklets share a launcher taskIid; the report is /task/<workletIid>.
const hub = {
  widget: 'root',
  tenant: 'acme',
  title: { widget: 'titleStaticText', text: 'My Team Management' },
  body: {
    widget: 'landingPage',
    children: [
      { widget: 'landingPageWorklet', label: 'My Team', taskIid: '2997$2151', workletIid: '501$326' },
      { widget: 'landingPageWorklet', label: 'View All Associates in My Organization', taskIid: '3001$26', workletIid: '1422$607' },
    ],
  },
};
const cols = ['Full Name', 'Compensation Grade', 'Job Profile', 'Last Promotion Date', 'Performance Rating'];
const report = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'View All Associates in My Organization' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'grid',
        rowCount: 1,
        deepRowCount: 1,
        columns: cols.map((label, i) => ({ widget: 'column', columnId: `c${i}`, label })),
        rows: [
          {
            widget: 'row',
            cellsMap: {
              c0: { widget: 'text', value: 'Pat Doe' },
              c1: { widget: 'monikerList', instances: [{ widget: 'moniker', text: 'M04', instanceId: '314$1' }] },
              c2: { widget: 'monikerList', instances: [{ widget: 'moniker', text: 'Senior Engineer', instanceId: '219$1' }] },
              c3: { widget: 'date', value: '03/01/2024' },
              c4: { widget: 'monikerList', instances: [{ widget: 'moniker', text: 'Performing', instanceId: '672$70' }] },
            },
          },
        ],
      },
    ],
  },
};

function makeClient(extra: Record<string, unknown> = {}) {
  const transport = new RoutingTransport({
    [APPS]: apps,
    '/acme/task/14860$62.htmld': hub,
    '/acme/task/1422$607.htmld': report,
    ...extra,
  });
  return { client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }), transport };
}

describe('WorkdayClient.getTeamSnapshot', () => {
  it('reads the org-wide associates report from the My Team hub', async () => {
    const { client } = makeClient();
    expect(await client.getTeamSnapshot()).toEqual({
      report: 'View All Associates in My Organization',
      people: [
        {
          'Full Name': 'Pat Doe',
          'Compensation Grade': 'M04',
          'Job Profile': 'Senior Engineer',
          'Last Promotion Date': '03/01/2024',
          'Performance Rating': 'Performing',
        },
      ],
    });
  });

  it('only fetches the hub and the report — not the other worklets', async () => {
    const { client, transport } = makeClient();
    await client.getTeamSnapshot();
    expect(transport.calls.map((c) => c.path)).not.toContain('/acme/task/501$326.htmld');
  });

  it('takes another report by name and lists the options when nothing matches', async () => {
    const { client } = makeClient();
    await expect(client.getTeamSnapshot('headcount')).rejects.toThrow(/View All Associates in My Organization/);
  });
});
