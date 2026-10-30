import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  confirmTokenParam,
  confirmWrite,
} from '@chrischall/mcp-utils';
import type { WorkdayClient } from '../client.js';
import { untrustedDescription, untrustedResponse, viewArg, viewResponse } from '../view.js';

/**
 * Your open Workday requests (promotion consideration forms and the like):
 * read them, and — behind the fleet confirm gate — change their answers and
 * Save for Later or Submit them.
 *
 * THE ONLY WRITES IN THIS SERVER. Every one goes through `confirmWrite`:
 * phase 1 returns a preview and a single-use token and sends nothing; only a
 * repeat call carrying that token writes. The token is bound to the request,
 * the action, the exact answers, the preview, and a hash of the request's
 * saved answers from a FRESH read — so a token minted for one state of the
 * request, or for other answers, is refused.
 */
export function registerRequestTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_request',
    {
      title: 'Read your open requests',
      description: untrustedDescription(
        'List the requests waiting for you to revise (e.g. promotion consideration forms you started), ' +
          'each with its `request` id; or pass `request` to read one — every question with its help, ' +
          'whether it is required, its answer type/options, and the saved `answer`. Read-only.'
      ),
      annotations: {
        title: 'Read your open requests',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        request: z
          .string()
          .min(1)
          .optional()
          .describe('A `request` id from the list (e.g. `20447$18949`). Omit to list open requests.'),
      }),
    },
    async ({ request, view }) =>
      viewResponse(view, request ? await client.getRequest(request) : { requests: await client.listOpenRequests() })
  );

  server.registerTool(
    'workday_update_request',
    {
      title: 'Change and save or submit a request',
      description:
        'Change answers on one of your open requests and then Save for Later (`action: "save"`) or ' +
        'Submit it (`action: "submit"` — sends it on in Workday). `answers` maps a question number ' +
        '(or a distinctive part of the question) to the new answer; a choice must be one of its options. ' +
        'Unchanged answers are skipped; a submit needs every required question answered. After the write, ' +
        'the request is re-read to verify it. ' +
        `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`,
      annotations: {
        title: 'Change and save or submit a request',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        request: z.string().min(1).describe('The `request` id from `workday_get_request`.'),
        answers: z
          .record(z.string(), z.string())
          .default({})
          .describe('Question number (or part of the question text) → new answer.'),
        action: z
          .enum(['save', 'submit'])
          .describe('`save` = Save for Later (stays with you); `submit` = Submit (sends it on).'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ request, answers, action, confirmToken }, ctx) => {
      // Re-plan from a FRESH read on every call, so the token binds the
      // request as it is now.
      const plan = await client.planRequestUpdate(request, answers, action);
      const gate = await confirmWrite(ctx, {
        tool: 'workday_update_request',
        action: action === 'submit' ? 'request.submit' : 'request.save',
        summary:
          action === 'submit'
            ? `Submit Workday request ${plan.request}${plan.preview.changes.length ? ' with the changes below' : ''}`
            : `Save Workday request ${plan.request} for later with the changes below`,
        account: `${client.host}/${client.tenant}`,
        target: plan.request,
        revision: plan.revision,
        payload: plan.preview,
        args: { request, answers, action },
        ...(action === 'submit'
          ? { preview: { warning: 'Submit sends the request on in Workday; you cannot edit it afterwards unless it is sent back.' } }
          : {}),
        confirmToken,
      });
      if (gate) return gate;
      return untrustedResponse(await client.applyRequestUpdate(plan));
    }
  );
}
