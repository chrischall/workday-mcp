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

type Route = unknown | ((init: FetchInit) => unknown);

class RoutingTransport implements WorkdayTransport {
  calls: FetchInit[] = [];
  constructor(private routes: Record<string, Route>) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    this.calls.push(init);
    const route = this.routes[init.path];
    const hit = typeof route === 'function' ? (route as (i: FetchInit) => unknown)(init) : route;
    return {
      status: hit === undefined ? 404 : 200,
      body: hit === undefined ? 'not found' : typeof hit === 'string' ? hit : JSON.stringify(hit),
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

// The inbox API wants the token from boot-config's `appRoot` — a JSON string
// inside the JSON — not the `.htmld` envelope token (that one gets HTML back).
const bootConfig = {
  loginInfo: {},
  uiComponents: {},
  appRoot: JSON.stringify({ homeUri: '/acme/d/home.htmld', sessionSecureToken: 'INBOX-TOKEN-456' }),
};

const INBOX = '/acme/internalapi/internalapi/inbox/v2/acme/inboxItems';
const inboxItems = {
  total: 2,
  data: [
    {
      relatedItem: {
        title: 'Provide Employee Review Comments: Pat Doe',
        subtitle: 'Performance Review',
        subtitle2: '2 day(s) ago',
        createdDate: '2026-10-28T10:00:00.000Z',
        createdMomentAgoRounded: '2 day(s) ago',
        effectiveDate: '2026-12-31',
        itemType: { descriptor: 'Performance Review', id: 'x1' },
        instance: { id: 'i1', descriptor: 'Year-End', instanceID: '795$1' },
      },
      taskToExecute: {
        label: 'Provide Employee Review Comments',
        uri: '/acme/d/inst/2363$1/rel-task/2997$1195.htmld',
        mobileUri: '/m',
        task: { id: 't1', descriptor: 'Provide Employee Review Comments', instanceID: '2997$1195' },
      },
      relatedTasks: [
        { label: 'Reassign', uri: '/acme/d/inst/795$1/rel-task/2997$3473', task: {} },
        { label: 'View Details', uri: '/acme/d/inst/795$1/rel-task/2997$3463', task: {} },
      ],
      status: { starred: false },
    },
    {
      relatedItem: {
        title: 'Give Feedback: Sam Roe',
        createdDate: '2026-10-20T09:00:00.000Z',
        itemType: { descriptor: 'Feedback Request', id: 'x2' },
      },
      taskToExecute: { label: 'Give Feedback', uri: '/acme/d/inst/9$2/rel-task/2997$9.htmld' },
      relatedTasks: [],
      status: { starred: true },
    },
  ],
};

function makeClient(extra: Record<string, Route> = {}) {
  const transport = new RoutingTransport({
    '/acme/boot-config': bootConfig,
    [`${INBOX}?category=Actions&offset=0&limit=100`]: inboxItems,
    [`${INBOX}?category=Archive&offset=0&limit=100`]: { total: 0, data: [] },
    ...extra,
  });
  return { client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }), transport };
}

describe('WorkdayClient.getInbox', () => {
  it('lists the tasks waiting for you', async () => {
    const { client } = makeClient();
    const inbox = await client.getInbox();
    expect(inbox).toEqual({
      total: 2,
      items: [
        {
          title: 'Provide Employee Review Comments: Pat Doe',
          type: 'Performance Review',
          task: 'Provide Employee Review Comments',
          created: '2026-10-28T10:00:00.000Z',
          effective: '2026-12-31',
          uri: '/acme/inst/2363$1/rel-task/2997$1195.htmld',
          detailsUri: '/acme/inst/795$1/rel-task/2997$3463.htmld',
        },
        {
          title: 'Give Feedback: Sam Roe',
          type: 'Feedback Request',
          task: 'Give Feedback',
          created: '2026-10-20T09:00:00.000Z',
          starred: true,
          uri: '/acme/inst/9$2/rel-task/2997$9.htmld',
        },
      ],
    });
  });

  it("sends boot-config's token as the Session-Secure-Token header, and never returns it", async () => {
    const { client, transport } = makeClient();
    const inbox = await client.getInbox();
    const call = transport.calls.find((c) => c.path.startsWith(INBOX));
    expect(call?.method).toBe('GET');
    expect(call?.headers?.['Session-Secure-Token']).toBe('INBOX-TOKEN-456');
    expect(JSON.stringify(inbox)).not.toContain('INBOX-TOKEN-456');
  });

  it('reads the archive when asked', async () => {
    const { client, transport } = makeClient();
    expect(await client.getInbox('archive')).toEqual({ total: 0, items: [] });
    expect(transport.calls.some((c) => c.path.includes('category=Archive'))).toBe(true);
  });

  it('explains an HTML answer instead of failing to parse it', async () => {
    const { client } = makeClient({
      [`${INBOX}?category=Actions&offset=0&limit=100`]: '<!DOCTYPE html><html></html>',
    });
    await expect(client.getInbox()).rejects.toThrow(/inbox/i);
  });

  it('says so when boot-config carries no token', async () => {
    const { client } = makeClient({ '/acme/boot-config': { appRoot: '{}' } });
    await expect(client.getInbox()).rejects.toThrow(/token/i);
  });
});

const myRequests = {
  widget: 'root',
  title: { widget: 'titleStaticText', text: 'My Requests' },
  body: {
    widget: 'vbox',
    children: [
      {
        widget: 'grid',
        label: '',
        rowCount: 1,
        deepRowCount: 1,
        columns: ['Request', 'Type', 'Request ID', 'Status', 'Initiation Date'].map((label, i) => ({
          widget: 'column',
          columnId: `c${i}`,
          label,
        })),
        rows: [
          {
            widget: 'row',
            cellsMap: {
              c0: { widget: 'monikerList', instances: [{ widget: 'moniker', text: 'Promotion: Pat Doe', instanceId: 'r1' }] },
              c1: { widget: 'monikerList', instances: [{ widget: 'moniker', text: '2026 Promotion Form', instanceId: 't1' }] },
              c2: { widget: 'text', value: 'REQ-0042' },
              c3: { widget: 'text', value: 'In Progress' },
              c4: { widget: 'date', value: '10/30/2026' },
            },
          },
        ],
      },
    ],
  },
};

describe('WorkdayClient.getMyRequests', () => {
  it('lists the requests you created, with status', async () => {
    const { client } = makeClient({ '/acme/task/3005$4617.htmld': myRequests });
    expect(await client.getMyRequests()).toEqual({
      requests: [
        {
          Request: 'Promotion: Pat Doe',
          Type: '2026 Promotion Form',
          'Request ID': 'REQ-0042',
          Status: 'In Progress',
          'Initiation Date': '10/30/2026',
        },
      ],
    });
  });

  it('refuses a page that is not My Requests', async () => {
    const { client } = makeClient({
      '/acme/task/3005$4617.htmld': { ...myRequests, title: { widget: 'titleStaticText', text: 'Something Else' } },
    });
    await expect(client.getMyRequests()).rejects.toThrow(/My Requests/);
  });
});
