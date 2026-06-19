#!/usr/bin/env node
// workday-mcp entrypoint.
//
// Workday tenants sit behind corporate SSO (Ping/Okta/Entra) with MFA, so
// there is no server-side login: every request rides the user's already-
// signed-in `*.myworkday.com` tab, relayed through the shared fetchproxy
// browser extension over a 127.0.0.1:37149 WebSocket.
//
// Boot sequence mirrors the fleet's fetchproxy servers:
//   1. Construct the FetchproxyTransport (bound to the tenant host).
//   2. client.start() brings the bridge up BEFORE runMcp connects stdio,
//      preserving the deferred-config-error pattern — a bridge that can't come
//      up surfaces here, not by wedging the JSON-RPC channel. Missing tenant
//      config does NOT block boot: it surfaces on the first tool call.
//   3. runMcp registers tools, prints the stderr banner, wires SIGINT/SIGTERM
//      → client.close(), and connects stdio.
import { runMcp, readEnvVar } from '@chrischall/mcp-utils';
import { WorkdayClient } from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerTaskTools } from './tools/task.js';
import { registerAppsTools } from './tools/apps.js';
import { VERSION } from './version.js';

const DEFAULT_HOST = 'wd5.myworkday.com';

const host = readEnvVar('WORKDAY_HOST') ?? DEFAULT_HOST;
const portRaw = readEnvVar('WORKDAY_WS_PORT');
const port = portRaw ? Number(portRaw) : undefined;

const transport = new FetchproxyTransport({ port, host, version: VERSION });

const client = new WorkdayClient({ transport });
// Bring the bridge up before runMcp connects stdio (deferred-config-error
// pattern — a bridge failure surfaces here, before any tool call).
await client.start();

await runMcp({
  name: 'workday-mcp',
  version: VERSION,
  deps: client,
  tools: [
    (server) => registerHealthcheckTools(server, client),
    (server) => registerAppsTools(server, client),
    (server) => registerTaskTools(server, client),
  ],
  banner:
    `[workday-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    `Install the fetchproxy extension (see https://github.com/chrischall/fetchproxy), ` +
    `sign into https://${host}, and set WORKDAY_TENANT to your tenant slug. ` +
    `This project was developed and is maintained by AI (Claude). Use at your own discretion.`,
  shutdown: { onSignal: () => client.close() },
});
