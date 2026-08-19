import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';

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

const APPS_PATH = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
const ORG_TASK = '/acme/task/2998$2673.htmld';
const PROFILE_PATH = '/acme/inst/1$715/247$42.htmld';

const apps = {
  widget: 'configuredApps',
  children: [
    { widget: 'configuredAppsItem', label: 'Org Chart', taskIid: '2998$2673' },
    { widget: 'configuredAppsItem', label: 'My Team', taskIid: '2997$2151' },
  ],
};

// The org chart is what makes worker lookup tenant-agnostic: its navigator
// lists carry the concrete profile uri, from which the profile PREFIX for this
// tenant is derived at runtime rather than hardcoded.
const orgChart = {
  widget: 'root',
  title: 'Org Chart',
  body: {
    widget: 'hierarchyNavigator',
    workerIid: '247$100',
    ancestors: [
      {
        widget: 'navigatorDetail',
        relationship: 'ancestor',
        navigatorInstance: {
          widget: 'navigatorList',
          selfUriTemplate: '/acme/inst/1$715/247$9',
          instances: [{ widget: 'moniker', text: 'Top Boss', instanceId: '247$9' }],
        },
        navigatorItems: [{ widget: 'navigatorItem', detailOne: 'EVP' }],
      },
    ],
  },
};

const workerProfile = {
  widget: 'root',
  title: 'View Associate',
  body: {
    widget: 'compositeView',
    compositeView: {
      widget: 'compositeList',
      children: [
        {
          widget: 'compositeViewSection',
          label: 'Compensation',
          taskNodes: [
            {
              widget: 'compositeViewTask',
              label: 'Compensation',
              uri: '/acme/inst/1508$9/rel-task/2998$6374',
            },
            {
              widget: 'compositeViewTask',
              label: 'Pay Change History',
              uri: '/acme/inst/1508$9/rel-task/2998$6447',
            },
          ],
        },
      ],
    },
  },
};

const compCard = {
  widget: 'root',
  title: 'Compensation',
  body: { cardContentSections: [{ contentSectionName: 'Pay', contentSectionItems: [] }] },
};

function makeClient(extra: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    [APPS_PATH]: apps,
    [ORG_TASK]: orgChart,
    [PROFILE_PATH]: workerProfile,
    '/acme/inst/1508$9/rel-task/2998$6374.htmld': compCard,
    ...extra,
  };
  const transport = new RoutingTransport(routes);
  return {
    client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }),
    transport,
  };
}

describe('WorkdayClient.getWorker', () => {
  it('resolves a BARE worker id via the tenant profile prefix learned from the org chart', async () => {
    const { client, transport } = makeClient();
    const worker = await client.getWorker('247$42');
    expect(worker.kind).toBe('profile');
    expect(transport.calls.map((c) => c.path)).toContain(PROFILE_PATH);
  });

  it('fetches a full profile uri directly, without the org-chart lookup', async () => {
    const { client, transport } = makeClient();
    await client.getWorker(PROFILE_PATH);
    expect(transport.calls.map((c) => c.path)).not.toContain(ORG_TASK);
  });

  it('learns the prefix once and reuses it', async () => {
    const { client, transport } = makeClient({
      '/acme/inst/1$715/247$43.htmld': workerProfile,
    });
    await client.getWorker('247$42');
    await client.getWorker('247$43');
    expect(transport.calls.filter((c) => c.path === ORG_TASK)).toHaveLength(1);
  });

  it('explains itself when the tenant prefix cannot be learned', async () => {
    const transport = new RoutingTransport({ [APPS_PATH]: { widget: 'configuredApps', children: [] } });
    const client = new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' });
    await expect(client.getWorker('247$42')).rejects.toThrow(/org chart|profile uri/i);
  });
});

describe('WorkdayClient.getWorkerTask', () => {
  it('finds a named drill-in on the profile and fetches it', async () => {
    const { client } = makeClient();
    const out = await client.getWorkerTask('247$42', 'compensation');
    expect(out.matched).toBe('Compensation');
    expect(out.section).toBe('Compensation');
    expect(out.task.title).toBe('Compensation');
  });

  it('lists what IS available when the requested task is not on the profile', async () => {
    const { client } = makeClient();
    await expect(client.getWorkerTask('247$42', 'nonexistent thing')).rejects.toThrow(
      /Pay Change History/
    );
  });
});

describe('WorkdayClient.getOrgChart', () => {
  it('returns the management chain from the Org Chart app', async () => {
    const { client } = makeClient();
    const org = await client.getOrgChart();
    expect(org.ancestors[0]).toMatchObject({ name: 'Top Boss', profileUri: '/acme/inst/1$715/247$9.htmld' });
  });
});
