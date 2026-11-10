import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  confirmTokenParam,
  confirmWrite,
} from '@chrischall/mcp-utils';
import type { WorkdayClient } from '../client.js';
import { untrustedResponse } from '../view.js';
import { workMeta } from './hints.js';

const sharingArg = z
  .enum(['everyone', 'private', 'confidential'])
  .optional()
  .describe(
    'Who sees the feedback: `everyone` = Workday\'s "Share with others" (the usual default); `private` = ' +
      'Workday\'s "Share with …" one person — the recipient when giving feedback, you ("Share with me") on a ' +
      'request; `confidential` = "Don\'t share with <the person it is about>". Omit to keep the form\'s ' +
      'default. The preview shows Workday\'s exact label.'
  );

/**
 * Giving and requesting feedback — two WRITES, each behind the fleet confirm
 * gate. Phase 1 drives the Workday form up to (never through) Submit and
 * cancels it, so the preview shows the people, badge, template questions and
 * visibility exactly as Workday resolved them; the token is bound to a hash of
 * all of that. Phase 2 re-drives a fresh form and presses Submit only if it
 * still resolves to the same thing.
 */
export function registerFeedbackTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_give_feedback',
    {
      title: 'Give a colleague feedback',
      description:
        'Give a colleague feedback in Workday ("Give Feedback"), optionally with a badge. `to` is their ' +
        'name; `feedback` is plain text (blank line = new paragraph); `badge` is part of a badge name ' +
        '(the preview lists them if it does not match); `sharing` sets who sees it. The feedback goes on ' +
        'their Workday profile with the visibility shown in the preview. After submitting, your Feedback Given is re-read to verify. ' +
        `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`,
      _meta: workMeta('send', { aliases: ['give feedback', 'recognize', 'kudos', 'send feedback', 'badge'] }),
      annotations: {
        title: 'Give a colleague feedback',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        to: z.string().min(1).describe('The colleague\'s name, as Workday\'s people search finds them.'),
        feedback: z.string().min(1).describe('The feedback, plain text.'),
        badge: z.string().min(1).optional().describe('A badge, by part of its name, e.g. `own it`.'),
        sharing: sharingArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ to, feedback, badge, sharing, confirmToken }, ctx) => {
      const input = { to, feedback, ...(badge ? { badge } : {}), ...(sharing ? { sharing } : {}) };
      const plan = await client.planGiveFeedback(input);
      const gate = await confirmWrite(ctx, {
        tool: 'workday_give_feedback',
        action: 'feedback.give',
        summary: `Give feedback to ${plan.preview.to}${plan.preview.badge ? ` with the "${plan.preview.badge}" badge` : ''}`,
        account: `${client.host}/${client.tenant}`,
        target: plan.preview.to,
        revision: plan.revision,
        payload: plan.preview,
        args: input,
        preview: { warning: 'Feedback is posted to their Workday profile as soon as it is submitted.' },
        confirmToken,
      });
      if (gate) return gate;
      return untrustedResponse(await client.applyGiveFeedback(plan));
    }
  );

  server.registerTool(
    'workday_request_feedback',
    {
      title: 'Request feedback',
      description:
        'Ask colleagues for feedback in Workday — on yourself ("Get Feedback on Self"), or, as a manager, ' +
        'about someone on your team or under you (`about`, "Get Feedback on Associate" — Workday offers no ' +
        'peers or managers there). `from` lists who to ask, by ' +
        'name. Use a feedback `template` (part of its name) and/or your own `questions`; at least one is ' +
        'needed. Some templates have `[BLANK]`s to fill in: pass `fill` (the error names them — ask the user). ' +
        '`sharing` sets who sees the answers (e.g. `confidential` keeps them from the person they are ' +
        'about). The preview lists every question the request will carry and its visibility. Each person ' +
        'asked gets a task in their Workday inbox. After submitting, Feedback Requested is re-read to ' +
        `verify. ${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`,
      _meta: workMeta('send', { aliases: ['request feedback', 'ask for feedback', 'get feedback', '360 feedback'] }),
      annotations: {
        title: 'Request feedback',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        from: z.array(z.string().min(1)).min(1).describe('Who to ask, by name.'),
        about: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Someone on your team or under you in your management hierarchy to request feedback about (Workday ' +
              'offers no one else here). Omit to request feedback on yourself.'
          ),
        template: z.string().min(1).optional().describe('A feedback template, by part of its name.'),
        questions: z.array(z.string().min(1)).optional().describe('Your own questions, plain text.'),
        fill: z
          .record(z.string(), z.string().min(1))
          .optional()
          .describe(
            'Text for a template\'s `[BLANK]`s, by blank name, e.g. `{"ENTER BEHAVIOR": "delegating"}`. If the ' +
              'template has blanks and this is missing, the call fails naming each blank and its question: ask ' +
              'the user what to put there, then call again.'
          ),
        sharing: sharingArg,
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ from, about, template, questions, fill, sharing, confirmToken }, ctx) => {
      const input = {
        from,
        ...(fill && Object.keys(fill).length ? { fill } : {}),
        ...(sharing ? { sharing } : {}),
        ...(about ? { about } : {}),
        ...(template ? { template } : {}),
        ...(questions?.length ? { questions } : {}),
      };
      const plan = await client.planRequestFeedback(input);
      const subject = plan.preview.about === 'yourself' ? 'you' : plan.preview.about;
      const gate = await confirmWrite(ctx, {
        tool: 'workday_request_feedback',
        action: 'feedback.request',
        summary: `Ask ${plan.preview.from.join(', ')} for feedback on ${subject}`,
        account: `${client.host}/${client.tenant}`,
        target: plan.preview.about,
        revision: plan.revision,
        payload: plan.preview,
        args: input,
        preview: { warning: 'Each person asked gets a feedback task in their Workday inbox as soon as it is submitted.' },
        confirmToken,
      });
      if (gate) return gate;
      return untrustedResponse(await client.applyRequestFeedback(plan));
    }
  );
}
