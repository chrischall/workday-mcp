import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkdayClient, SessionNotAuthenticatedError } from '../client.js';
import { textResult } from '../mcp.js';
import {
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
} from '../transport-fetchproxy.js';

/**
 * Round-trip a small authenticated Workday endpoint through the full bridge so
 * the user can tell — with ONE call — which hop is broken:
 *
 *   - the fetchproxy WebSocket bridge is up (`bridge.role` non-null)
 *   - the fetchproxy browser extension is connected (request reaches a tab)
 *   - the signed-in Workday tab is responsive AND the session is still valid
 *     (vs. expired → bounced to SSO)
 *
 * Probe target: `/{tenant}/get-global-prefs.htmld?feature=doNotShowMobileAd` —
 * a tiny authenticated JSON endpoint. A clean round-trip proves bridge +
 * session; an SSO bounce isolates "session expired" from "bridge down".
 */

const PROBE_SUFFIX = '/get-global-prefs.htmld?feature=doNotShowMobileAd';

export function registerHealthcheckTools(server: McpServer, client: WorkdayClient): void {
  server.registerTool(
    'workday_healthcheck',
    {
      title: 'Verify the Workday bridge + session end-to-end',
      description:
        "Round-trips a small authenticated Workday endpoint through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, round-trip time, and a plain-English hint that distinguishes 'bridge never came up' from 'extension not connected' from 'Workday session expired (re-sign-in)'. Call this when a Workday tool fails and you want to know which hop broke. Read-only.",
      annotations: {
        title: 'Verify the Workday bridge + session end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const configError = client.configErrorMessage;
      if (configError) {
        return textResult({
          ok: false,
          configured: false,
          hint: configError,
        });
      }

      const probePath = `/${client.tenant}${PROBE_SUFFIX}`;
      let bodyLength = 0;
      let thrown: unknown;
      const probeResult = await client.runProbe(async (path) => {
        try {
          const body = await client.fetchRaw(path);
          bodyLength = body.length;
          return body;
        } catch (e) {
          thrown = e;
          throw e;
        }
      }, probePath);

      const bridge = probeResult.bridge;
      const probeUrl = `https://${client.host}${probePath}`;

      let error:
        | {
            kind: 'timeout' | 'bridge_down' | 'session_expired' | 'transport' | 'other';
            message: string;
            role_at_failure?: 'host' | 'peer' | null;
            elapsed_ms_at_timeout?: number;
            bridge_hint?: string;
          }
        | undefined;

      if (probeResult.error) {
        if (thrown instanceof SessionNotAuthenticatedError) {
          error = { kind: 'session_expired', message: thrown.message };
        } else if (thrown instanceof FetchproxyTimeoutError) {
          error = {
            kind: 'timeout',
            message: probeResult.error.message,
            role_at_failure: thrown.role,
            elapsed_ms_at_timeout: thrown.elapsedMs,
          };
        } else if (thrown instanceof FetchproxyBridgeDownError) {
          error = {
            kind: 'bridge_down',
            message: probeResult.error.message,
            role_at_failure: thrown.role,
            bridge_hint: thrown.hint,
          };
        } else if (probeResult.error.kind === 'http' || probeResult.error.kind === 'protocol') {
          error = { kind: 'transport', message: probeResult.error.message };
        } else {
          error = { kind: 'other', message: probeResult.error.message };
        }
      }

      return textResult({
        ok: probeResult.ok,
        configured: true,
        bridge: {
          role: bridge.role,
          port: bridge.port,
          server_version: bridge.server_version,
          fetch_timeout_ms: bridge.fetch_timeout_ms,
          last_success_at: bridge.last_success_at,
          last_failure_at: bridge.last_failure_at,
          last_failure_reason: bridge.last_failure_reason,
          consecutive_failures: bridge.consecutive_failures,
        },
        probe: probeResult.ok
          ? { url: probeUrl, elapsed_ms: probeResult.elapsed_ms, body_length: bodyLength }
          : { url: probeUrl, elapsed_ms: probeResult.elapsed_ms },
        ...(error ? { error } : {}),
        hint: hintFor({ ok: probeResult.ok, role: bridge.role, errorKind: error?.kind, host: client.host }),
      });
    }
  );
}

function hintFor(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  errorKind?: string;
  host: string;
}): string {
  if (args.ok) {
    return 'Bridge + Workday session are healthy. If a specific tool still fails, the issue is that task path, not the bridge.';
  }
  if (args.errorKind === 'session_expired') {
    return `Your Workday session expired. Open https://${args.host} in your browser, complete the SSO sign-in, then retry.`;
  }
  if (args.errorKind === 'bridge_down') {
    return "The fetchproxy extension's service worker is not responding. Click the fetchproxy extension icon (or reload a Workday tab) to wake it, then retry.";
  }
  if (args.role === null) {
    return 'The bridge never bound a role — listen() may have failed on startup. Check workday-mcp stderr and confirm port 37149 is free.';
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}) but the request timed out. Either the fetchproxy extension isn't connected, or no signed-in ${args.host} tab is open. Open Workday and retry.`;
  }
  if (args.errorKind === 'transport') {
    return `Protocol error before any HTTP response — most often no Workday tab is open. Open https://${args.host}, sign in, and retry.`;
  }
  return 'Unexpected error — see error.message.';
}
