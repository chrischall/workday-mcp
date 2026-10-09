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
import {
  WorkdayClient,
  WorkdayConfigError,
  normalizeHost,
  parsePort,
} from './client.js';
import { FetchproxyTransport } from './transport-fetchproxy.js';
import { registerHealthcheckTools } from './tools/healthcheck.js';
import { registerTaskTools } from './tools/task.js';
import { registerAppsTools } from './tools/apps.js';
import { registerPeopleTools } from './tools/people.js';
import { registerRawTools } from './tools/raw.js';
import { VERSION } from './version.js';

// Normalized once and shared with the client, so the bridge subdomain and the
// client's off-host sign-out check agree on the same bare hostname.
const host = normalizeHost(readEnvVar('WORKDAY_HOST'));
// An invalid port must not crash boot or reach the transport as NaN: fall back
// to the default bridge port and surface the error on the first tool call.
let port: number | undefined;
let configError: WorkdayConfigError | undefined;
try {
  port = parsePort(readEnvVar('WORKDAY_WS_PORT'));
} catch (e) {
  configError = e as WorkdayConfigError;
}

const transport = new FetchproxyTransport({ port, host, version: VERSION });

const client = new WorkdayClient({ transport, host, configError });
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
    (server) => registerPeopleTools(server, client),
    (server) => registerRawTools(server, client),
  ],
  banner:
    `[workday-mcp] v${VERSION} — WebSocket bridge via @fetchproxy/server on 127.0.0.1:${port ?? 37149}. ` +
    `Install ContextMint Bridge — the fetchproxy browser extension, renamed; source at ` +
    `https://github.com/nullnet-app/contextmint-bridge, verify release zips with their .sha256 — ` +
    `sign into https://${host}, and set WORKDAY_TENANT to your tenant slug. ` +
    `This project was developed and is maintained by AI (Claude). Use at your own discretion.`,
  shutdown: { onSignal: () => client.close() },
});
