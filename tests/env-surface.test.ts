import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The server's env knobs, as documented in mint.yaml's `env:` list, must be
 * settable on every install path with the same required flag: manifest.json
 * (.mcpb, wired through user_config) and server.json (MCP registry).
 * WORKDAY_TENANT is the only required one — every data tool needs it (the
 * server still boots without it so the install-time tools/list probe answers).
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const EXPECTED: Record<string, boolean> = {
  WORKDAY_TENANT: true,
  WORKDAY_HOST: false,
  WORKDAY_WS_PORT: false,
  WORKDAY_DEBUG: false,
};

describe('env surface', () => {
  it('mint.yaml documents exactly the expected vars', () => {
    const names = [...read('../mint.yaml').matchAll(/^\s+- name: (WORKDAY_[A-Z_]+)$/gm)].map((m) => m[1]);
    expect(names.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('server.json declares each with the right isRequired', () => {
    const json = JSON.parse(read('../server.json')) as {
      packages: Array<{ environmentVariables: Array<{ name: string; isRequired?: boolean }> }>;
    };
    const decls = Object.fromEntries(
      json.packages.flatMap((p) => p.environmentVariables).map((v) => [v.name, v.isRequired === true]),
    );
    expect(decls).toEqual(EXPECTED);
  });

  it('manifest.json wires each through user_config with the right required flag', () => {
    const json = JSON.parse(read('../manifest.json')) as {
      server: { mcp_config: { env: Record<string, string> } };
      user_config: Record<string, { required?: boolean }>;
    };
    const env = json.server.mcp_config.env;
    expect(Object.keys(env).sort()).toEqual(Object.keys(EXPECTED).sort());
    const wired = new Set<string>();
    for (const [name, value] of Object.entries(env)) {
      const key = /^\$\{user_config\.([^}]+)\}$/.exec(value)?.[1];
      expect(key, name).toBeDefined();
      expect(json.user_config[key!], name).toBeDefined();
      expect(json.user_config[key!].required === true, name).toBe(EXPECTED[name]);
      wired.add(key!);
    }
    // No user_config entry is asked of the user and then dropped.
    expect([...wired].sort()).toEqual(Object.keys(json.user_config).sort());
  });
});
