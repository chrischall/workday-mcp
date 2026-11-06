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
import { workMeta } from './hints.js';

/**
 * Benefits: what you have now, and an open enrollment event in full.
 *
 * Two reads, and one write. Every entry point is resolved from live tenant
 * data by LABEL — your own task catalog's "Benefits" folder, your inbox's
 * benefit items — never from a captured id.
 *
 * The write, `workday_update_benefit_enrollment`, goes through `confirmWrite`
 * like `workday_update_request`: phase 1 plans from a FRESH read and returns
 * a preview and a single-use token, sending nothing; only a repeat call with
 * that token writes. The token is bound to the event, the action, the exact
 * changes, the preview, and a hash of the enrollment's current elections.
 */
export function registerBenefitTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_benefits',
    {
      title: 'Read your benefits',
      description: untrustedDescription(
        'Read your current benefit elections: each plan (medical, dental, vision, HSA/FSA, life, ' +
          '401k…) with its coverage level, start dates, covered dependents, beneficiaries, and what ' +
          'you and the company pay per pay period, plus the totals. `show` switches to your ' +
          '`dependents`, `beneficiaries`, or election `history` instead. For an open enrollment ' +
          'event (plans on offer, next year\'s costs, the deadline) use ' +
          '`workday_get_benefit_enrollment`. Read-only.'
      ),
      _meta: workMeta('lookup', {
        aliases: ['benefits', 'my benefits', 'benefit elections', 'health insurance', 'dependents', 'beneficiaries'],
      }),
      annotations: {
        title: 'Read your benefits',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        show: z
          .enum(['elections', 'dependents', 'beneficiaries', 'history'])
          .optional()
          .describe('What to read (default `elections`).'),
      }),
    },
    async ({ show, view }) => viewResponse(view, await client.getBenefits(show))
  );

  server.registerTool(
    'workday_get_benefit_enrollment',
    {
      title: 'Read an open benefits enrollment',
      description: untrustedDescription(
        'Read an open benefit event from your Workday inbox, such as annual/open enrollment, without ' +
          'changing it. Returns the enrollment window (when it closes), what is elected right now ' +
          '(what you get if you change nothing), how each plan\'s cost and your total cost change ' +
          'from today, waived coverages, beneficiaries, and for every plan type the plans on offer ' +
          'with what you and the company would pay and which is selected. Use `planType` (e.g. ' +
          '"medical") with `rates: true` to add each plan\'s price by coverage level and provider ' +
          'link. Also lists open benefit to-dos (e.g. dependent documentation). Read-only: it never ' +
          'selects a plan or presses Save for Later or Review and Sign; make elections with ' +
          '`workday_update_benefit_enrollment`. ' +
          'Workday marks each plan type it opens as "Reviewed" on your enrollment page.'
      ),
      _meta: workMeta('lookup', {
        aliases: ['open enrollment', 'annual enrollment', 'benefits enrollment', 'enroll in benefits', 'compare plans'],
      }),
      annotations: {
        title: 'Read an open benefits enrollment',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        event: z
          .string()
          .min(1)
          .optional()
          .describe('Part of the event\'s inbox title, when more than one benefit event is open. Default: the newest.'),
        planType: z
          .string()
          .min(1)
          .optional()
          .describe('Read only plan types whose name contains this, e.g. `medical`, `dental`, `life`.'),
        rates: z
          .boolean()
          .optional()
          .describe('Add each plan\'s price at every coverage level (one extra page per plan). Needs `planType`.'),
      }),
    },
    async ({ event, planType, rates, view }) =>
      viewResponse(view, await client.getBenefitEnrollment({ event, planType, rates }))
  );

  server.registerTool(
    'workday_update_benefit_enrollment',
    {
      title: 'Change and save or submit your benefits enrollment',
      description:
        'Make elections in an open benefit event (e.g. annual enrollment) and then Save for Later ' +
        '(`action: "save"`) or Review and Sign and Submit it (`action: "submit"` — signs the electronic ' +
        'signature and submits your elections). Each change names a `planType` (part of its name, e.g. ' +
        '"medical", "dependent care") and either a `plan` to choose, `waive: true`, or an ' +
        '`annualContribution` in dollars for an HSA/FSA (with or without `plan`). Plan types you do not ' +
        'mention keep what the event already has; changes already in place are skipped. Use ' +
        '`workday_get_benefit_enrollment` first to see the plan types, plans and prices. After the write ' +
        'the event is re-read to verify it. ' +
        `${CONFIRM_FLOW_SENTENCE} ${CONFIRM_INJECTION_RULE}`,
      _meta: workMeta('change', {
        aliases: ['enroll in benefits', 'open enrollment', 'change benefits', 'submit benefits', 'waive benefit'],
      }),
      annotations: {
        title: 'Change and save or submit your benefits enrollment',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: z.object({
        event: z
          .string()
          .min(1)
          .optional()
          .describe('Part of the event\'s inbox title, when more than one benefit event is open. Default: the newest.'),
        changes: z
          .array(
            z.object({
              planType: z.string().min(1).describe('The plan type, e.g. `medical`, `USA Dependent Care FSA`.'),
              plan: z.string().min(1).optional().describe('The plan to choose (part of its name).'),
              waive: z.boolean().optional().describe('`true` to waive this plan type.'),
              annualContribution: z
                .number()
                .positive()
                .optional()
                .describe('HSA/FSA amount for the year, in dollars (e.g. `7800`).'),
            })
          )
          .default([])
          .describe('The elections to change. Empty with `action: "submit"` submits the enrollment as it stands.'),
        action: z
          .enum(['save', 'submit'])
          .describe('`save` = Save for Later (a draft); `submit` = Review and Sign, accept, and Submit.'),
        confirmToken: confirmTokenParam,
      }),
    },
    async ({ event, changes, action, confirmToken }, ctx) => {
      // Re-plan from a FRESH read on every call, so the token binds the
      // enrollment as it is now.
      const plan = await client.planBenefitUpdate({ event, changes, action });
      const gate = await confirmWrite(ctx, {
        tool: 'workday_update_benefit_enrollment',
        action: action === 'submit' ? 'benefits.submit' : 'benefits.save',
        summary:
          action === 'submit'
            ? `Sign and submit your benefit elections for "${plan.event}"${plan.preview.changes.length ? ' with the changes below' : ' as they stand'}`
            : `Save your benefit elections for "${plan.event}" for later with the changes below`,
        account: `${client.host}/${client.tenant}`,
        target: plan.event,
        revision: plan.revision,
        payload: plan.preview,
        args: { event, changes, action },
        ...(action === 'submit'
          ? {
              preview: {
                warning:
                  'Submit signs Workday\'s electronic signature — authorizing the payroll deductions and sending your ' +
                  'information to the plan providers — and submits your elections for the plan year.',
              },
            }
          : {}),
        confirmToken,
      });
      if (gate) return gate;
      return untrustedResponse(await client.applyBenefitUpdate(plan));
    }
  );
}
