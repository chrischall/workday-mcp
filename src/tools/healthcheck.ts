import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { WorkdayClient, SessionNotAuthenticatedError, WorkdayConfigError } from '../client.js';

/**
 * Round-trip a small authenticated Workday endpoint through the full bridge so
 * the user can tell — with ONE call — which hop is broken: the fetchproxy
 * WebSocket bridge, the browser extension, or the signed-in Workday tab / SSO
 * session.
 *
 * The probe loop, error classification, bridge projection, and hint ladder all
 * live in the shared `registerBridgeHealthcheckTool`
 * (`@chrischall/mcp-utils/fetchproxy`); this module supplies only the Workday
 * specifics:
 *
 *   - `probeFn` hits `/{tenant}/get-global-prefs.htmld` — a tiny authenticated
 *     JSON endpoint — through the same client path real tools use, so the
 *     sign-in guard fires exactly as it does in production. Reading
 *     `client.tenant` inside the probe throws `WorkdayConfigError` when the
 *     tenant is unset, which `classifyThrown` turns into an actionable result
 *     (replacing the old `configured: false` early return).
 *   - `classifyThrown` maps the SSO bounce (`SessionNotAuthenticatedError`) to a
 *     `session_expired` kind with Workday re-sign-in copy, and the deferred
 *     config error to `not_configured`.
 */

const PROBE_SUFFIX = '/get-global-prefs.htmld?feature=doNotShowMobileAd';

export function registerHealthcheckTools(server: McpServer, client: WorkdayClient): void {
  // Registration must not throw when the tenant is unset (deferred config), so
  // fall back to the bare suffix for the display URL; the probe below computes
  // the real tenant-scoped path and lets WorkdayConfigError surface.
  const probePath = client.configErrorMessage
    ? PROBE_SUFFIX
    : `/${client.tenant}${PROBE_SUFFIX}`;

  registerBridgeHealthcheckTool({
    server,
    prefix: 'workday',
    probePath,
    hostLabel: client.host,
    transport: {
      runProbe: (fetchFn, path) => client.runProbe(fetchFn, path),
      status: () => client.bridgeStatus(),
    },
    // Ignore the passed display path and build the tenant-scoped one; accessing
    // `client.tenant` throws WorkdayConfigError when unconfigured, which
    // classifyThrown maps to `not_configured`.
    probeFn: () => client.fetchRaw(`/${client.tenant}${PROBE_SUFFIX}`),
    classifyThrown: (err) => {
      if (err instanceof WorkdayConfigError) {
        return { kind: 'not_configured', hint: err.message };
      }
      if (err instanceof SessionNotAuthenticatedError) {
        return {
          kind: 'session_expired',
          hint:
            `Your Workday session expired. Open https://${client.host} in your browser, ` +
            'complete the SSO sign-in, then retry.',
        };
      }
      return undefined;
    },
  });
}
