import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { untrustedDescription, viewArg, viewResponse } from '../view.js';
import { workMeta } from './hints.js';

/**
 * Reports and dashboards. Running a report is a read: a report's prompt form
 * is driven on its own flow and always cancelled, and anything that turns out
 * to be a business-process form is refused (see `WorkdayClient.runReport`).
 */
export function registerReportTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_run_report',
    {
      title: 'Run a Workday report',
      description: untrustedDescription(
        'Run a Workday report and return its rows, keyed by column, straight into the conversation. ' +
          '`report` is the report\'s task id (`1422$242`), its address-bar URL from Workday ' +
          '(…/d/task/1422$242.htmld), or the name of a report on one of your dashboards. Reports ' +
          'with prompts run with their defaults unless you pass `prompts` (label → value, or several ' +
          'values for a list prompt); if Workday rejects them, the error names each prompt and what ' +
          'it was set to so you can retry. Read-only: the prompt form is cancelled afterwards and ' +
          'business-process forms are refused.'
      ),
      _meta: workMeta('lookup', { aliases: ['run report', 'workday report', 'position report', 'promotion report'] }),
      annotations: {
        title: 'Run a Workday report',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        report: z
          .string()
          .min(1)
          .describe('Task id (`1422$242`), the report URL from your browser, or a report name from a dashboard.'),
        prompts: z
          .record(z.string(), z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]))
          .optional()
          .describe(
            'Prompt values by prompt label (or a distinctive part of it), e.g. ' +
              '`{"Supervisory Organization": "VFS Operations"}`. A list prompt\'s defaults are replaced.'
          ),
        limit: z.number().int().min(1).max(5000).optional().describe('Most rows to return per table (default 500).'),
      }),
    },
    async ({ report, prompts, limit, view }) =>
      viewResponse(view, await client.runReport(report, { ...(prompts ? { prompts } : {}), ...(limit ? { limit } : {}) }))
  );

  server.registerTool(
    'workday_get_dashboard',
    {
      title: 'Open a Workday dashboard',
      description: untrustedDescription(
        'Open a Workday dashboard (e.g. "Year End Dashboard") by its name in your app menu, task id ' +
          'or URL: every tab\'s worklets and report links, each with the `reportId` to pass to ' +
          '`workday_run_report`. Pass `run: true` to also run every worklet\'s report and include ' +
          'its rows; a worklet that fails shows its error. Read-only.'
      ),
      _meta: workMeta('lookup', { aliases: ['dashboard', 'year end dashboard'] }),
      annotations: {
        title: 'Open a Workday dashboard',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({
        view: viewArg(),
        dashboard: z.string().min(1).describe('Dashboard name from your app menu, e.g. `year end`, or its task id / URL.'),
        run: z.boolean().optional().describe('Also run each worklet\'s report (default false).'),
      }),
    },
    async ({ dashboard, run, view }) => viewResponse(view, await client.getDashboard(dashboard, run ? { run } : {}))
  );
}
