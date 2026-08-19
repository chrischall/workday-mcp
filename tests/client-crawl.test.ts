import { describe, it, expect } from 'vitest';
import { WorkdayClient } from '../src/client.js';
import type {
  FetchInit,
  FetchResult,
  WorkdayTransport,
  BridgeStatus,
  BridgeProbeResult,
} from '../src/transport.js';

/** Transport that answers per-path from a routing table and records calls. */
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

function card(name: string, rows: Array<Record<string, string>>) {
  return {
    widget: 'root',
    title: name,
    sessionSecureToken: 'SECRET-DO-NOT-LEAK',
    body: {
      cardContentSections: [
        {
          contentSectionName: name,
          contentSectionItems: rows.map((r) => ({
            label: { widget: 'text', label: 'Label', value: r.label },
            value: { widget: 'text', label: 'Value', value: r.value },
          })),
        },
      ],
    },
  };
}

const HUB_PATH = '/acme/task/2998$43525.htmld';
const CARD_A = '/acme/card/all/a1/39330!tok.htmld';
const CARD_B = '/acme/card/all/b2/39330!tok.htmld';

/** A container hub: near-empty shell that only points at its child cards —
 *  the shape that made v1's single fetch useless for manager apps. */
const hub = {
  widget: 'root',
  title: 'My Team',
  sessionSecureToken: 'SECRET-DO-NOT-LEAK',
  body: {
    cardContentSections: [],
    children: [
      { widget: 'card', label: 'Direct Reports', uri: CARD_A },
      { widget: 'card', label: 'Time Off Balances', uri: CARD_B },
    ],
  },
};

function makeClient(routes: Record<string, unknown>) {
  const transport = new RoutingTransport(routes);
  const client = new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' });
  return { client, transport };
}

describe('WorkdayClient.crawl', () => {
  const routes = {
    [HUB_PATH]: hub,
    [CARD_A]: card('Direct Reports', [{ label: 'Sam Report', value: 'Engineer' }]),
    [CARD_B]: card('Time Off Balances', [{ label: 'PTO', value: '12 days' }]),
  };

  it('follows a hub down to its child cards instead of returning the empty shell', async () => {
    const { client } = makeClient(routes);
    const result = await client.crawl(HUB_PATH, { depth: 1 });
    expect(result.title).toBe('My Team');
    expect(result.cards.map((c) => c.label)).toEqual(['Direct Reports', 'Time Off Balances']);
    expect(result.cards[0].task.sections[0].rows[0].cells).toEqual({
      label: 'Sam Report',
      value: 'Engineer',
    });
  });

  it('does not follow anything at depth 0', async () => {
    const { client, transport } = makeClient(routes);
    const result = await client.crawl(HUB_PATH, { depth: 0 });
    expect(result.cards).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  it('honours a maxCards budget and reports what it skipped', async () => {
    const { client } = makeClient(routes);
    const result = await client.crawl(HUB_PATH, { depth: 1, maxCards: 1 });
    expect(result.cards).toHaveLength(1);
    expect(result.skipped).toEqual([CARD_B]);
  });

  it('never refetches a uri it has already visited', async () => {
    const selfRef = {
      widget: 'root',
      title: 'Loop',
      body: { children: [{ widget: 'card', uri: CARD_A }] },
    };
    const { client, transport } = makeClient({
      [HUB_PATH]: selfRef,
      [CARD_A]: { widget: 'root', title: 'A', body: { children: [{ widget: 'card', uri: CARD_A }] } },
    });
    await client.crawl(HUB_PATH, { depth: 3 });
    const cardFetches = transport.calls.filter((c) => c.path === CARD_A);
    expect(cardFetches).toHaveLength(1);
  });

  it('records a failed child card without aborting the whole crawl', async () => {
    const { client } = makeClient({ [HUB_PATH]: hub, [CARD_A]: card('Direct Reports', []) });
    const result = await client.crawl(HUB_PATH, { depth: 1 });
    expect(result.cards.map((c) => c.label)).toEqual(['Direct Reports']);
    expect(result.errors?.[0].uri).toBe(CARD_B);
  });

  it('never leaks the session token from any hop', async () => {
    const { client } = makeClient(routes);
    const result = await client.crawl(HUB_PATH, { depth: 1 });
    expect(JSON.stringify(result)).not.toContain('SECRET-DO-NOT-LEAK');
  });
});

describe('WorkdayClient.resolveApp', () => {
  const appsPath = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';
  const apps = {
    widget: 'configuredApps',
    children: [
      { widget: 'configuredAppsItem', label: 'Benefits and Pay', taskIid: '2998$43525' },
      { widget: 'configuredAppsItem', label: 'My Team', taskIid: '2998$1' },
      { widget: 'configuredAppsItem', label: 'Time Off and Leave', taskIid: '2998$2' },
    ],
  };

  it('matches an app by case-insensitive substring', async () => {
    const { client } = makeClient({ [appsPath]: apps });
    expect((await client.resolveApp('my team'))?.taskId).toBe('2998$1');
    expect((await client.resolveApp('time off'))?.taskId).toBe('2998$2');
  });

  it('matches by regex when given one, preferring the earliest app', async () => {
    const { client } = makeClient({ [appsPath]: apps });
    expect((await client.resolveApp(/team|benefits/i))?.label).toBe('Benefits and Pay');
  });

  it('returns null when nothing matches', async () => {
    const { client } = makeClient({ [appsPath]: apps });
    expect(await client.resolveApp('payroll admin console')).toBeNull();
  });
});

describe('WorkdayClient.graphql', () => {
  it('refuses a mutation — the server is read-only', async () => {
    const { client } = makeClient({});
    await expect(client.graphql('mutation Foo { doThing }')).rejects.toThrow(/read-only/i);
    await expect(client.graphql('subscription S { x }')).rejects.toThrow(/read-only/i);
  });

  it('allows a query and a bare shorthand document', async () => {
    const path = '/wday/pex/graphql/graphql?operation=Inbox';
    const { client, transport } = makeClient({ [path]: { data: { inbox: [] } } });
    const out = await client.graphql('query Inbox { inbox { id } }', {}, 'Inbox');
    expect(out).toEqual({ data: { inbox: [] } });
    // calls[0] is the session-token priming GET; the GraphQL call is the POST.
    const post = transport.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(path);
    expect(JSON.parse(post!.body!).query).toContain('query Inbox');
  });

  it('is not fooled by the word mutation inside a field name or string', async () => {
    const path = '/wday/pex/graphql/graphql?operation=Q';
    const { client } = makeClient({ [path]: { data: {} } });
    await expect(
      client.graphql('query Q { mutationLog { id } }', {}, 'Q')
    ).resolves.toBeDefined();
  });
});

describe('WorkdayClient.fetchRawJson', () => {
  it('returns the raw envelope with secrets redacted', async () => {
    const { client } = makeClient({ [HUB_PATH]: hub });
    const raw = (await client.fetchRawJson(HUB_PATH)) as Record<string, unknown>;
    expect(raw.title).toBe('My Team');
    expect(raw.sessionSecureToken).toBe('[redacted]');
  });
});
