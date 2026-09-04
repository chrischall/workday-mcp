import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';

/**
 * The people surface — what a manager reaches for.
 *
 * All four tools resolve their entry point from LIVE tenant data (the app menu
 * and the org chart) rather than from captured task ids, because Workday's ids
 * are per-tenant: an id captured from one tenant addresses nothing on another.
 */
export function registerPeopleTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_org_chart',
    {
      title: 'Read your org chart',
      description:
        'Read the reporting chain around you: each person with their business title, location, ' +
        'report count, and a `profileUri` you can pass straight to `workday_get_worker`. ' +
        'Resolves the Org Chart app from your own app menu. Read-only.',
      annotations: {
        title: 'Read your org chart',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const org = await client.getOrgChart();
      return minifiedResult({
        workerId: org.workerId,
        managementChain: org.ancestors,
        atThisLevel: org.nodes,
        note:
          org.nodes.length === 0
            ? 'Workday returned the chain upward only. Expanding downward to direct reports is a ' +
              'POST-only navigation in this tenant; read a person with `workday_get_worker` and use ' +
              'their profile tasks (e.g. "Organizations", "Management Chain") instead.'
            : undefined,
      });
    }
  );

  server.registerTool(
    'workday_get_worker',
    {
      title: 'Read a worker profile',
      description:
        "Read a worker's Workday profile and return the CATALOG of everything readable about " +
        'them: sections (Job, Compensation, Benefits, Contact, Personal, Performance, Career, ' +
        'Feedback) each listing named, fetchable tasks. Pass a `profileUri` from ' +
        '`workday_get_org_chart` or any reference, or a bare worker id like `247$42`. ' +
        'Then use `workday_get_worker_task` to open one by name. Shows only what your own ' +
        'Workday permissions already allow. Read-only.',
      annotations: {
        title: 'Read a worker profile',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        worker: z
          .string()
          .min(1)
          .describe(
            'A full profile uri (e.g. `/acme/inst/1$715/247$42.htmld`) or a bare worker instance ' +
              'id (e.g. `247$42`).'
          ),
      },
    },
    async ({ worker }) => {
      const page = await client.getWorker(worker);
      return minifiedResult({
        title: page.title,
        sections: page.profile?.sections ?? [],
        fields: page.sections,
        grids: page.grids,
      });
    }
  );

  server.registerTool(
    'workday_get_worker_task',
    {
      title: 'Open one task on a worker profile',
      description:
        'Open a single named item from a worker\'s profile — "Compensation", "Job Details", ' +
        '"Performance Reviews", "Management Chain", "Benefits", "Goals", "Pay Change History", ' +
        'and so on. Matched case-insensitively against that worker\'s own task catalog; if it ' +
        'does not match, the error lists exactly what is available. Read-only.',
      annotations: {
        title: 'Open one task on a worker profile',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        view: viewArg(),
        worker: z.string().min(1).describe('Profile uri or bare worker instance id.'),
        task: z
          .string()
          .min(1)
          .describe('Task name as it appears on the profile, e.g. `Compensation`.'),
      },
    },
    async ({ worker, task, view }) => {
      const out = await client.getWorkerTask(worker, task);
      return viewResponse(view, out);
    }
  );

  server.registerTool(
    'workday_get_my_profile',
    {
      title: 'Read your own Workday profile',
      description:
        'Read your own worker profile — the same catalog `workday_get_worker` returns, for ' +
        'yourself. Use it to find your pay, benefits, time off, goals, and feedback. Read-only.',
      annotations: {
        title: 'Read your own Workday profile',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const page = await client.getMyProfile();
      return minifiedResult({
        title: page.title,
        sections: page.profile?.sections ?? [],
        fields: page.sections,
        grids: page.grids,
      });
    }
  );
}
