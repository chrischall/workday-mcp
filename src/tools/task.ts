import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * The read workhorse: fetch any Workday `*.htmld` data endpoint through the
 * signed-in session and return a flat, secret-free view of it — the page
 * title, the current user, every section's label/value fields, navigable
 * references (with their instance ids + drill-in uris), and the account-level
 * related tasks + export links.
 *
 * Workday data endpoints carry opaque, page-context-bound instance tokens in
 * their paths (e.g. `/{tenant}/inst/13102!.../cacheable-task/2998$43525.htmld`),
 * so the path comes from a prior task's `references[].uri` / `relatedTasks[]`,
 * or from copying the URL of a Workday page you have open (a `/d/...` SPA URL
 * is accepted and normalized to its data endpoint automatically).
 */
export function registerTaskTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_task',
    {
      title: 'Read a Workday task / data card',
      description:
        'Fetch a Workday page (task or data card) by its path and return a structured, ' +
        'read-only view: title, current user, each section as label/value fields, navigable ' +
        'references (instance id + drill-in uri), and the page\'s related tasks + export links. ' +
        'The path is a Workday `*.htmld` endpoint — take it from a prior result\'s `references[].uri` ' +
        'or `relatedTasks[].uri`, or paste the URL of a Workday page you have open (SPA `/d/...` URLs ' +
        'are normalized automatically). Every request rides your signed-in Workday tab. Read-only; ' +
        'no data is mutated.',
      annotations: {
        title: 'Read a Workday task / data card',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Workday data endpoint path, e.g. `/acme/inst/13102!ABC/cacheable-task/2998$43525.htmld`, ' +
              'or a copied `/acme/d/...` SPA URL, or a bare suffix like `quickaccess/fetch.htmld`.'
          ),
        expand: z
          .boolean()
          .optional()
          .describe(
            'Follow the page down to the child cards holding its real content. Turn this on when ' +
              'a page comes back with no sections — container/hub pages delegate everything to ' +
              'children whose uris exist only inside the parent response.'
          ),
        depth: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Levels to follow when `expand` is set (default 1).'),
        maxCards: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('Cap on child cards fetched when expanding (default 12).'),
      },
    },
    async ({ path, expand, depth, maxCards }) => {
      if (!expand && depth === undefined) {
        const task = await client.getTask(path);
        return textResult(task);
      }
      const page = await client.crawl(path, {
        ...(depth !== undefined ? { depth } : {}),
        ...(maxCards !== undefined ? { maxCards } : {}),
      });
      return textResult(page);
    }
  );
}
