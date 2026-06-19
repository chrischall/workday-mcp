import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkdayClient } from '../client.js';
import { textResult } from '../mcp.js';

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
      return textResult({ apps, count: apps.length });
    }
  );
}
