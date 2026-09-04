import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkdayClient } from '../client.js';
import { minifiedResult } from '../mcp.js';
import { viewArg, viewResponse } from '../view.js';

/**
 * List the user's Workday apps (Personal Information, Benefits and Pay,
 * Directory, Time Off, …) with a launchable task id. This is the discovery
 * entry point: call it first, then pass an app's `taskId` to
 * `workday_get_task` to open it and follow its references deeper.
 */
export function registerAppsTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_get_apps',
    {
      title: 'List your Workday apps',
      description:
        'List the Workday apps available on your home screen, each with a launchable task id. ' +
        'Use this to discover what you can read, then pass an app\'s `taskId` to `workday_get_task` ' +
        'to open it. Some apps share a generic launcher id; if one returns a near-empty page, open ' +
        'the app in your browser and pass that URL to `workday_get_task` instead. Read-only.',
      annotations: {
        title: 'List your Workday apps',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const apps = await client.getApps();
      return minifiedResult({ apps, count: apps.length });
    }
  );

  server.registerTool(
    'workday_open_app',
    {
      title: 'Open a Workday app by name',
      description:
        'Open one of your Workday apps by name — "My Team Management", "Talent and Performance", ' +
        '"Time", "Absence", "Benefits and Pay", "Org Chart", "Total Rewards" — and read it, ' +
        'following the app down to the child cards that hold its real content. Most Workday app ' +
        'hubs return a near-empty shell on their own; this follows the links for you. ' +
        'Matched case-insensitively against your own app menu, so it works without knowing any ' +
        'task ids. Read-only.',
      annotations: {
        title: 'Open a Workday app by name',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        view: viewArg(),
        app: z
          .string()
          .min(1)
          .describe('App name or a distinctive part of it, e.g. `talent` or `my team`.'),
        depth: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe('Levels of child cards to follow (default 1, 0 = the hub page only).'),
        maxCards: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('Cap on child cards fetched (default 12). Each is a real browser fetch.'),
      },
    },
    async ({ app, depth, maxCards, view }) => {
      const page = await client.openApp(app, {
        ...(depth !== undefined ? { depth } : {}),
        ...(maxCards !== undefined ? { maxCards } : {}),
      });
      return viewResponse(view, page);
    }
  );
}
