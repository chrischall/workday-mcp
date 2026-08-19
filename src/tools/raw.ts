import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { textResult } from '../mcp.js';
import { capPayload } from '../redact.js';

/** Default cap on a raw payload. Workday envelopes routinely exceed 100 KB. */
const DEFAULT_MAX_BYTES = 60_000;

/**
 * The escape hatches: raw `.htmld` reads and GraphQL queries.
 *
 * The typed tools cover the shapes this server models. These two cover
 * everything else — a card `parseTask` does not recognize yet, or the PEX
 * GraphQL surface that serves inbox and search. Both hand back Workday's own
 * response, so both run it through the redactor first: the typed parsers are
 * safe by construction (allowlist), these are safe by denylist.
 */
export function registerRawTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_fetch',
    {
      title: 'Fetch a raw Workday endpoint',
      description:
        'GET any Workday data endpoint and return the RAW JSON with secrets redacted — the ' +
        'escape hatch for pages the typed tools do not model yet. Prefer `workday_get_task` ' +
        '(structured) when it works; reach for this to explore an unfamiliar page or to see ' +
        'fields the parser drops. Bare uris get `.htmld` appended and `/d/` SPA paths are ' +
        'normalized. Read-only (GET only).',
      annotations: {
        title: 'Fetch a raw Workday endpoint',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Workday path, e.g. `/acme/inst/1$715/247$42.htmld` or `2998$43525`.'),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(400_000)
          .optional()
          .describe(`Payload cap before truncation (default ${DEFAULT_MAX_BYTES}).`),
      },
    },
    async ({ path, maxBytes }) => {
      const raw = await client.fetchRawJson(path);
      const capped = capPayload(raw, maxBytes ?? DEFAULT_MAX_BYTES);
      return textResult(capped.data);
    }
  );

  server.registerTool(
    'workday_graphql',
    {
      title: 'Run a Workday GraphQL query',
      description:
        "Run a read-only GraphQL query against Workday's PEX surface " +
        '(`/wday/pex/graphql`). This is the only route to surfaces that have no GET-able ' +
        '`.htmld` endpoint — notably the Inbox / "My Tasks" and global search. Workday does ' +
        'not publish these operations, so you supply the document; expect to iterate. ' +
        '`mutation` and `subscription` documents are REFUSED — this server is read-only.',
      annotations: {
        title: 'Run a Workday GraphQL query',
        readOnlyHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        query: z.string().min(1).describe('A GraphQL `query` document. Mutations are rejected.'),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Variables for the query.'),
        operationName: z
          .string()
          .optional()
          .describe('Operation name; also sent as the `?operation=` query parameter.'),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(400_000)
          .optional()
          .describe(`Payload cap before truncation (default ${DEFAULT_MAX_BYTES}).`),
      },
    },
    async ({ query, variables, operationName, maxBytes }) => {
      const out = await client.graphql(query, variables ?? {}, operationName);
      const capped = capPayload(out, maxBytes ?? DEFAULT_MAX_BYTES);
      return textResult(capped.data);
    }
  );
}
