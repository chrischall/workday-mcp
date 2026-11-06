import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { WorkdayClient } from '../src/client.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerAppsTools } from '../src/tools/apps.js';
import { registerTaskTools } from '../src/tools/task.js';
import { registerPeopleTools } from '../src/tools/people.js';
import { registerRawTools } from '../src/tools/raw.js';
import { registerReviewTools } from '../src/tools/review.js';
import { registerRequestTools } from '../src/tools/requests.js';
import { registerBenefitTools } from '../src/tools/benefits.js';
import type { BridgeProbeResult, BridgeStatus, FetchInit, FetchResult, WorkdayTransport } from '../src/transport.js';

/**
 * Context-group hints (mcp-host's `_meta.mint` contract), asserted against the
 * SERVED tool list rather than a hand-kept table, so a new tool without a hint
 * fails here.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, any> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

const bootConfig = {
  appRoot: JSON.stringify({ homeUri: '/acme/d/home.htmld', sessionSecureToken: 'TOKEN' }),
};
const INBOX = '/acme/internalapi/internalapi/inbox/v2/acme/inboxItems';

function item(title: string, task: string, created?: string, starred = false) {
  return {
    relatedItem: { title, ...(created ? { createdDate: created } : {}), itemType: { descriptor: 'Performance Review' } },
    taskToExecute: { label: task, uri: '/acme/d/inst/1$1/rel-task/2997$1.htmld' },
    relatedTasks: [],
    status: { starred },
  };
}

class RoutingTransport implements WorkdayTransport {
  constructor(private inbox: (init: FetchInit) => unknown) {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async fetch(init: FetchInit): Promise<FetchResult> {
    const body =
      init.path === '/acme/boot-config'
        ? bootConfig
        : init.path.startsWith(INBOX)
          ? this.inbox(init)
          : {};
    return { status: 200, body: JSON.stringify(body), url: `https://wd5.myworkday.com${init.path}` };
  }
  async runProbe(): Promise<BridgeProbeResult> {
    return {} as BridgeProbeResult;
  }
  status(): BridgeStatus {
    return {} as BridgeStatus;
  }
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(inbox: (init: FetchInit) => unknown = () => ({ total: 0, data: [] })) {
  const client = new WorkdayClient({ transport: new RoutingTransport(inbox), tenant: 'acme' });
  const h = await createTestHarness((s) => {
    registerHealthcheckTools(s, client);
    registerAppsTools(s, client);
    registerTaskTools(s, client);
    registerPeopleTools(s, client);
    registerRawTools(s, client);
    registerReviewTools(s, client);
    registerRequestTools(s, client);
    registerBenefitTools(s, client);
  });
  close = () => h.close();
  const tools = (await h.client.listTools()).tools as Listed[];
  const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const r = (await h.client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
    return r.content[0]!.text;
  };
  return { tools, text };
}

describe('_meta.mint hints', () => {
  it('every tool except the healthcheck carries domain "work" and a valid intent in the contract shape', async () => {
    const { tools } = await setup();
    expect(tools.length).toBe(22);
    for (const t of tools) {
      if (t.name.endsWith('_healthcheck')) continue;
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(Object.keys(m!).every((k) => KEYS.includes(k)), t.name).toBe(true);
      expect(DOMAINS).toContain(m!.domain);
      expect(m!.domain, t.name).toBe('work');
      expect(INTENTS, t.name).toContain(m!.intent);
      if (m!.aliases) {
        expect(m!.aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of m!.aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
      const props = t.inputSchema.properties ?? {};
      if (m!.subject) expect(props, t.name).toHaveProperty(m!.subject);
      if (m!.when) {
        expect(props, t.name).toHaveProperty(m!.when.start);
        expect(props, t.name).toHaveProperty(m!.when.end);
      }
    }
  });

  it('marks canonical only on a read, only on whats-new/due/on, and at most once per intent', async () => {
    const { tools } = await setup();
    const canonical = tools.filter((t) => t._meta?.mint?.canonical);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter((t) => t._meta!.mint!.intent === intent).length, intent).toBeLessThanOrEqual(1);
    }
    expect(canonical.map((t) => t.name)).toEqual(['workday_get_inbox']);
  });

  it('the inbox is the canonical "what is due at work" read, with no subject (one person, nothing to list)', async () => {
    const { tools } = await setup();
    const m = tools.find((t) => t.name === 'workday_get_inbox')?._meta?.mint;
    expect(m).toMatchObject({ domain: 'work', intent: 'whats-due', canonical: true });
    expect(m).not.toHaveProperty('subject');
    expect(m).not.toHaveProperty('when');
  });

  it('the one write is a change, never canonical', async () => {
    const { tools } = await setup();
    const m = tools.find((t) => t.name === 'workday_update_request')?._meta?.mint;
    expect(m).toMatchObject({ domain: 'work', intent: 'change' });
    expect(m).not.toHaveProperty('canonical');
  });
});

describe('workday_get_inbox view "brief"', () => {
  const parse = (text: string) => JSON.parse(text) as { untrusted_content: boolean; note: string; data: string[] };

  it('answers one line per item inside the untrusted-data envelope', async () => {
    const { text } = await setup(() => ({
      total: 2,
      data: [
        item('Provide Employee Review Comments: Pat Doe', 'Provide Employee Review Comments', '2026-10-28T10:00:00.000Z', true),
        item('Give Feedback: Sam Roe', 'Give Feedback'),
      ],
    }));
    const out = parse(await text('workday_get_inbox', { view: 'brief' }));
    expect(out.untrusted_content).toBe(true);
    expect(out.note).toMatch(/written by other Workday users/);
    expect(out.data).toEqual([
      'Provide Employee Review Comments: Pat Doe — 2026-10-28 — to do, starred',
      'Give Feedback: Sam Roe — no date — to do',
    ]);
  });

  it('keeps every line within 120 characters', async () => {
    const { text } = await setup(() => ({
      total: 1,
      data: [item('x'.repeat(300), 'Do it', '2026-10-28T10:00:00.000Z')],
    }));
    const [line] = parse(await text('workday_get_inbox', { view: 'brief' })).data;
    expect(line!.length).toBeLessThanOrEqual(120);
    expect(line).toMatch(/… — 2026-10-28 — to do$/);
  });

  it('escapes a title that starts with "-- " or "\\" with one backslash, so it never reads as a note', async () => {
    const { text } = await setup(() => ({
      total: 3,
      data: [
        item('-- none', 'Approve', '2026-10-01'),
        item('\\server\\share', 'Approve', '2026-10-02'),
        item('--draft', 'Approve', '2026-10-03'),
      ],
    }));
    expect(parse(await text('workday_get_inbox', { view: 'brief' })).data).toEqual([
      '\\-- none — 2026-10-01 — to do',
      '\\\\server\\share — 2026-10-02 — to do',
      '--draft — 2026-10-03 — to do',
    ]);
  });

  it('keeps an escaped long title within 120 characters as a whole', async () => {
    const { text } = await setup(() => ({
      total: 1,
      data: [item(`-- ${'y'.repeat(300)}`, 'Do it', '2026-10-28T10:00:00.000Z')],
    }));
    const [line] = parse(await text('workday_get_inbox', { view: 'brief' })).data;
    expect(line!.length).toBeLessThanOrEqual(120);
    expect(line!.startsWith('\\-- y')).toBe(true);
    expect(line).toMatch(/… — 2026-10-28 — to do$/);
  });

  it('says "-- none" for an empty inbox', async () => {
    const { text } = await setup();
    expect(parse(await text('workday_get_inbox', { view: 'brief' })).data).toEqual(['-- none']);
  });

  it('notes a partial page as "-- N of M shown"', async () => {
    const { text } = await setup(() => ({ total: 250, data: [item('A', 'Approve', '2026-10-01')] }));
    expect(parse(await text('workday_get_inbox', { view: 'brief' })).data).toEqual([
      'A — 2026-10-01 — to do',
      '-- 1 of 250 shown',
    ]);
  });

  it('marks archived items done', async () => {
    let asked = '';
    const { text } = await setup((init) => {
      asked = init.path;
      return { total: 1, data: [item('Old task', 'Approve', '2026-09-01T00:00:00.000Z')] };
    });
    expect(parse(await text('workday_get_inbox', { view: 'brief', category: 'archive' })).data).toEqual([
      'Old task — 2026-09-01 — done',
    ]);
    expect(asked).toContain('category=Archive');
  });

  it('leaves the other rungs unchanged', async () => {
    const { text } = await setup(() => ({ total: 1, data: [item('A', 'Approve', '2026-10-01')] }));
    const out = JSON.parse(await text('workday_get_inbox', {})) as { untrusted_content: boolean; total: number; items: unknown[] };
    expect(out.untrusted_content).toBe(true);
    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
  });
});
