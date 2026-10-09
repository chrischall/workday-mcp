// Invariant: .claude-plugin/plugin.json declares its MCP config under
// `mcpServers`, the key Claude Code reads. `mcp` is an unknown field that
// Claude Code silently ignores; it only appeared to work here because
// ./.mcp.json is the default location anyway. Copies of the pattern with a
// non-default path (office-outlook-mcp, microsoft-teams-mcp) broke their
// plugin installs.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
) as Record<string, unknown>;

describe('.claude-plugin/plugin.json', () => {
  it('declares the MCP config under mcpServers, not mcp', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(typeof plugin.mcpServers).toBe('string');
  });

  it('points mcpServers at a file that exists', () => {
    expect(existsSync(join(ROOT, plugin.mcpServers as string))).toBe(true);
  });
});
