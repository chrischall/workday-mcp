import { describe, it, expect } from 'vitest';
import { WorkdayClient, assertReadOnlyGraphql } from '../src/client.js';
import { redactTree } from '../src/redact.js';
import { registerTaskTools } from '../src/tools/task.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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

const APPS = '/acme/quickaccess/fetch.htmld?shouldFetchUpcApps=true';

function makeClient(routes: Record<string, unknown>) {
  const transport = new RoutingTransport(routes);
  return {
    client: new WorkdayClient({ transport, tenant: 'acme', host: 'wd5.myworkday.com' }),
    transport,
  };
}

// ── Important #1 ────────────────────────────────────────────────────────────
describe('workday_graphql redaction (review: response bypassed the redactor)', () => {
  it('redacts secrets in the GraphQL response, as three files already claim it does', async () => {
    const gqlPath = '/wday/pex/graphql/graphql?operation=Q';
    const { client } = makeClient({
      [APPS]: { widget: 'configuredApps', children: [] },
      [gqlPath]: {
        data: { inbox: [{ id: '1' }] },
        sessionSecureToken: 'SECRET-DO-NOT-LEAK',
        nested: { csrfToken: 'SECRET-DO-NOT-LEAK' },
      },
    });
    const out = (await client.graphql('query Q { inbox { id } }', {}, 'Q')) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(out)).not.toContain('SECRET-DO-NOT-LEAK');
    expect(out.sessionSecureToken).toBe('[redacted]');
    // real data still comes through
    expect(out.data).toEqual({ inbox: [{ id: '1' }] });
  });
});

// ── Important #2 ────────────────────────────────────────────────────────────
describe('read-only guard (review: `#` inside a string blanked the rest of the line)', () => {
  it('refuses a mutation hidden behind a `#` inside a string literal', () => {
    expect(() =>
      assertReadOnlyGraphql('query Q { f(a: "#") } mutation Evil { deleteEverything }')
    ).toThrow(/read-only/i);
  });

  it('refuses a mutation after a block-string containing a hash', () => {
    expect(() =>
      assertReadOnlyGraphql('query Q { f(a: """#""") } mutation Evil { x }')
    ).toThrow(/read-only/i);
  });

  it('still allows a genuine query whose string contains a hash', () => {
    expect(() => assertReadOnlyGraphql('query Q { f(a: "#tag") }')).not.toThrow();
  });

  it('still ignores a real comment mentioning mutation', () => {
    expect(() => assertReadOnlyGraphql('# this is not a mutation\nquery Q { f }')).not.toThrow();
  });

  it('still rejects a plain mutation and allows a field named mutationLog', () => {
    expect(() => assertReadOnlyGraphql('mutation M { x }')).toThrow(/read-only/i);
    expect(() => assertReadOnlyGraphql('query Q { mutationLog { id } }')).not.toThrow();
  });
});

// ── Nit: grid-cell PII ──────────────────────────────────────────────────────
describe('redactTree grid columns (review: PII columns reached workday_fetch raw)', () => {
  it('redacts cells whose COLUMN LABEL names PII, not just sibling-label widgets', () => {
    const grid = {
      widget: 'grid',
      label: 'Team',
      columns: [
        { widget: 'column', columnId: '1.1', label: 'Worker' },
        { widget: 'column', columnId: '1.2', label: 'Social Security Number' },
        { widget: 'column', columnId: '1.3', label: 'Bank Account Number' },
      ],
      rows: [
        {
          widget: 'row',
          cellsMap: {
            '1.1': { widget: 'text', value: 'Sam Report' },
            '1.2': { widget: 'text', value: '123-45-6789' },
            '1.3': { widget: 'text', value: '000123456' },
          },
        },
      ],
    };
    const out = JSON.stringify(redactTree(grid));
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('000123456');
    expect(out).toContain('Sam Report'); // ordinary columns survive
  });
});

// ── Nit: openApp double fetch ───────────────────────────────────────────────
describe('openApp app-menu fetches (review: listed alternatives with a second fetch)', () => {
  it('fetches the app menu only once, even on the no-match error path', async () => {
    const { client, transport } = makeClient({
      [APPS]: {
        widget: 'configuredApps',
        children: [{ widget: 'configuredAppsItem', label: 'Directory', taskIid: '1$1' }],
      },
    });
    await expect(client.openApp('nonexistent app')).rejects.toThrow(/Directory/);
    expect(transport.calls.filter((c) => c.path === APPS)).toHaveLength(1);
  });
});

// ── Nit: get_task expand/depth/maxCards coherence ───────────────────────────
describe('workday_get_task expand semantics (review: maxCards alone was ignored)', () => {
  /** Capture the registered handler so the tool's own branching is exercised. */
  function taskHandler(client: WorkdayClient) {
    let handler!: (args: Record<string, unknown>) => Promise<unknown>;
    const server = {
      registerTool: (_n: string, _c: unknown, h: typeof handler) => {
        handler = h;
      },
    } as unknown as McpServer;
    registerTaskTools(server, client);
    return handler;
  }

  const page = { widget: 'root', title: 'Hub', body: { children: [] } };

  it('crawls when only maxCards is supplied', async () => {
    const withChild = {
      widget: 'root',
      body: { children: [{ widget: 'card', uri: '/acme/card/all/c1/tok.htmld' }] },
    };
    const { client, transport } = makeClient({
      '/acme/task/1$1.htmld': withChild,
      '/acme/card/all/c1/tok.htmld': page,
    });
    await taskHandler(client)({ path: '1$1', maxCards: 5 });
    expect(transport.calls.map((c) => c.path)).toContain('/acme/card/all/c1/tok.htmld');
  });

  it('does NOT crawl when expand is explicitly false, even with depth set', async () => {
    const withChild = {
      widget: 'root',
      title: 'Hub',
      body: { children: [{ widget: 'card', uri: '/acme/card/all/c1/tok.htmld' }] },
    };
    const { client, transport } = makeClient({
      '/acme/task/1$1.htmld': withChild,
      '/acme/card/all/c1/tok.htmld': page,
    });
    await taskHandler(client)({ path: '1$1', expand: false, depth: 2 });
    expect(transport.calls.map((c) => c.path)).toEqual(['/acme/task/1$1.htmld']);
  });

  it('still crawls when expand is true', async () => {
    const withChild = {
      widget: 'root',
      body: { children: [{ widget: 'card', uri: '/acme/card/all/c1/tok.htmld' }] },
    };
    const { client, transport } = makeClient({
      '/acme/task/1$1.htmld': withChild,
      '/acme/card/all/c1/tok.htmld': page,
    });
    await taskHandler(client)({ path: '1$1', expand: true });
    expect(transport.calls.map((c) => c.path)).toContain('/acme/card/all/c1/tok.htmld');
  });
});

// ── Round 2: important — guard evasion via `"""` inside a `#` comment ───────
describe('read-only guard, round 2 (review: ordering hole merely moved)', () => {
  // Stripping strings BEFORE comments let a `"""` opened inside a comment run
  // to a `"""` in a LATER comment, blanking the `mutation` between them — while
  // a real GraphQL lexer sees two comments and a live write operation.
  it('refuses a mutation fenced by `"""` sequences that live inside comments', () => {
    expect(() =>
      assertReadOnlyGraphql('# """\nmutation Evil { deleteEverything }\n# """')
    ).toThrow(/read-only/i);
  });

  it('refuses a mutation between a commented `"""` and a real block string', () => {
    expect(() =>
      assertReadOnlyGraphql('# """\nmutation Evil { x }\nquery Q { f(a: """ok""") }')
    ).toThrow(/read-only/i);
  });

  it('refuses a mutation after a single quote opened inside a comment', () => {
    expect(() =>
      assertReadOnlyGraphql('# "\nmutation Evil { x }\nquery Q { f(a: "s") }')
    ).toThrow(/read-only/i);
  });

  it('fails CLOSED on an unterminated string rather than blanking the rest', () => {
    expect(() => assertReadOnlyGraphql('query Q { f(a: ") } mutation Evil { x }')).toThrow(
      /read-only/i
    );
  });

  it('still allows legitimate documents that mix comments, strings and hashes', () => {
    expect(() =>
      assertReadOnlyGraphql('# a comment about mutation\nquery Q { f(a: "#tag", b: """m""") }')
    ).not.toThrow();
    expect(() => assertReadOnlyGraphql('query Q { mutationLog { id } }')).not.toThrow();
    expect(() => assertReadOnlyGraphql('{ f }')).not.toThrow();
  });
});

// ── Round 2: nit — nested grid column scoping ──────────────────────────────
describe('redactTree nested grids (review: inherited column ids leaked across grids)', () => {
  it('lets an inner grid with its own columns shadow an outer grid PII column id', () => {
    const outer = {
      widget: 'grid',
      columns: [{ widget: 'column', columnId: '1.1', label: 'Social Security Number' }],
      rows: [
        { widget: 'row', cellsMap: { '1.1': { widget: 'text', value: '123-45-6789' } } },
      ],
      nested: {
        widget: 'grid',
        // SAME column id, but here it is an innocuous column
        columns: [{ widget: 'column', columnId: '1.1', label: 'Worker' }],
        rows: [{ widget: 'row', cellsMap: { '1.1': { widget: 'text', value: 'Sam Report' } } }],
      },
    };
    const out = JSON.stringify(redactTree(outer));
    expect(out).not.toContain('123-45-6789'); // outer PII column still redacted
    expect(out).toContain('Sam Report'); // inner grid must NOT inherit the outer scope
  });
});

// ── Round 2: fail closed on documents that cannot be lexed ─────────────────
describe('read-only guard, malformed documents (found by differential fuzzing)', () => {
  // An unterminated `"""` makes any scanner disagree with a real lexer about
  // where a `mutation` lives. Workday would reject the document as a syntax
  // error anyway, but the guard must not depend on that.
  it('refuses a document with an unterminated block string', () => {
    expect(() => assertReadOnlyGraphql('""" # mutation Evil { x }\n) )')).toThrow(
      /unterminated string/i
    );
  });

  it('refuses a document with an unterminated quoted string', () => {
    expect(() => assertReadOnlyGraphql('query Q { f(a: "oops) }')).toThrow(/unterminated string/i);
  });

  it('still accepts well-formed strings, escapes and block strings', () => {
    expect(() => assertReadOnlyGraphql('query Q { f(a: "a\\"b", c: """x""") }')).not.toThrow();
  });
});

describe('read-only guard — cases found by differential fuzzing vs graphql@17', () => {
  // Under a regex alternation the leading `"""` re-paired as `""` + `" # "`,
  // leaving no stray quote, so the malformed document looked clean and the
  // `mutation` was swallowed by what then read as a comment.
  it('refuses an unterminated `"""` whose quotes re-pair under a naive reading', () => {
    expect(() =>
      assertReadOnlyGraphql('""" # "\n# mutation Evil { x } )\n"s"  \n# "')
    ).toThrow(/unterminated string/i);
  });

  it('refuses a mutation hidden between block-string fences opened in comments', () => {
    expect(() =>
      assertReadOnlyGraphql('# """\nmutation Evil { x }\n# """\nquery Q { f }')
    ).toThrow(/read-only/i);
  });

  it('allows a block string that merely CONTAINS the word mutation', () => {
    expect(() =>
      assertReadOnlyGraphql('query Q { f(a: """mutation Evil { x }""") }')
    ).not.toThrow();
  });
});
