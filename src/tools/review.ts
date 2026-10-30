import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { untrustedDescription, viewArg, viewResponse } from '../view.js';

/**
 * The review-season surface: your team, their reviews and feedback, and the
 * forms (promotion consideration and the like) you fill in for them.
 *
 * Like the people tools, every entry point is resolved from live tenant data
 * by LABEL — your own profile's organizations, a worker's own catalog, the
 * request types you can create — never from a captured id.
 */
export function registerReviewTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_team',
    {
      title: 'List your team',
      description:
        'List the people on the teams you manage — every supervisory organization you lead, with ' +
        'each member\'s name, worker id, profile link, position and location. Pass a member\'s ' +
        '`workerId` to `workday_get_reviews`, `workday_get_feedback` or `workday_get_worker`. ' +
        'Read-only.',
      annotations: {
        title: 'List your team',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({}),
    },
    async () => minifiedResult(await client.getTeam())
  );

  server.registerTool(
    'workday_get_reviews',
    {
      title: "Read a worker's performance reviews",
      description: untrustedDescription(
        "List a worker's performance reviews (period, status, manager rating), or pass `review` " +
          'to open one in full: every section\'s manager and employee ratings and comments, goals, ' +
          'and development items. `review` is part of the review\'s name ("2025 year-end") or ' +
          '`latest`. Shows only what your own Workday permissions allow. Read-only.'
      ),
      annotations: {
        title: "Read a worker's performance reviews",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        worker: z
          .string()
          .min(1)
          .describe('A `workerId` from `workday_get_team` (e.g. `247$42`) or a profile uri.'),
        review: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Open this review in full: part of its name, e.g. `2025 year-end`, or `latest`. Omit to list reviews.'
          ),
      }),
    },
    async ({ worker, review, view }) =>
      viewResponse(
        view,
        review ? await client.getReview(worker, review) : await client.getReviews(worker)
      )
  );

  server.registerTool(
    'workday_get_feedback',
    {
      title: "Read a worker's feedback",
      description: untrustedDescription(
        "Read the feedback a worker has received (default), given, or requested — each item's " +
          'date, author, badge, type and full text. Read-only.'
      ),
      annotations: {
        title: "Read a worker's feedback",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        worker: z
          .string()
          .min(1)
          .describe('A `workerId` from `workday_get_team` (e.g. `247$42`) or a profile uri.'),
        kind: z
          .enum(['received', 'given', 'requested'])
          .optional()
          .describe('Which feedback to read (default `received`).'),
      }),
    },
    async ({ worker, kind, view }) => viewResponse(view, await client.getFeedback(worker, kind))
  );

  server.registerTool(
    'workday_get_request_form',
    {
      title: 'Load a request form',
      description: untrustedDescription(
        'Load the form for a Workday request type — e.g. a promotion consideration form — and ' +
          'return its instructions and every question with its help text, whether it is required, ' +
          'and its answer type and options. Use it to draft answers before filling the form in ' +
          'Workday. To read the form, Workday has to open a new request; this tool cancels it ' +
          'before returning and never presses Submit or Save for Later, so nothing is created.'
      ),
      annotations: {
        title: 'Load a request form',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        requestType: z
          .string()
          .min(1)
          .describe(
            'Request type name or a distinctive part of it, as listed under Requests → Create ' +
              'Request, e.g. `2026 Promotion Consideration Form (Senior Manager`.'
          ),
      }),
    },
    async ({ requestType, view }) => viewResponse(view, await client.getRequestForm(requestType))
  );

  server.registerTool(
    'workday_get_inbox',
    {
      title: 'Read your Workday inbox',
      description: untrustedDescription(
        'List the tasks waiting for you in Workday ("My Tasks"): review comments to provide, ' +
          'feedback requests, questionnaires, approvals — each with its business-process type, ' +
          'dates, and a `uri` you can open read-only with `workday_get_task`. `category: "archive"` ' +
          'lists completed items instead. Read-only.'
      ),
      annotations: {
        title: 'Read your Workday inbox',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        category: z
          .enum(['actions', 'archive'])
          .optional()
          .describe('`actions` (default) for open tasks, `archive` for completed ones.'),
      }),
    },
    async ({ category, view }) => viewResponse(view, await client.getInbox(category))
  );

  server.registerTool(
    'workday_get_my_requests',
    {
      title: 'List your requests',
      description: untrustedDescription(
        'List the Workday requests you created — promotion consideration forms and the like — ' +
          'with type, request id, status, resolution and dates. Read-only.'
      ),
      annotations: {
        title: 'List your requests',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => viewResponse(view, await client.getMyRequests())
  );
}
