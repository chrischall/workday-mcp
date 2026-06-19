// Boot smoke test: spawn the REAL bundled artifact (dist/bundle.js) in a temp
// dir with NO node_modules — the exact `.mcpb` runtime — and run the MCP
// `initialize` + `tools/list` handshake. Catches two classes of bug that
// fully-mocked unit tests never see:
//   - an eager top-level import of an esbuild-externalized dep crashing the
//     bundle at load (the `.mcpb` ships no node_modules)
//   - a wrong `bin`/outfile path
//
// Runs WITHOUT WORKDAY_TENANT set (deferred-config-error pattern: the server
// must still boot and answer tools/list) and on an isolated WS port so it
// can't peer with the developer's live fetchproxy bridges on 37149.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

describe('server boot (bundled artifact, no node_modules)', () => {
  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    }
  });

  it('answers initialize + tools/list with the read-only roster', async () => {
    // Copy ONLY the bundle into a temp dir with no node_modules — the .mcpb runtime.
    const dir = mkdtempSync(join(tmpdir(), 'workday-mcp-boot-'));
    const bundleCopy = join(dir, 'bundle.js');
    copyFileSync(BUNDLE, bundleCopy);

    const child = spawn(process.execPath, [bundleCopy], {
      cwd: dir,
      env: { ...process.env, WORKDAY_TENANT: '', WORKDAY_WS_PORT: '41777' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const tools = await new Promise<string[]>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('timed out waiting for tools/list'));
      }, 15_000);

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        for (const line of buf.split('\n')) {
          if (!line.trim()) continue;
          let msg: { id?: number; result?: { tools?: { name: string }[] } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 2 && msg.result?.tools) {
            clearTimeout(timer);
            child.kill();
            resolve(msg.result.tools.map((t) => t.name).sort());
          }
        }
      });
      child.on('error', reject);

      child.stdin.write(
        rpc(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'boot-test', version: '0' },
        })
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(rpc(2, 'tools/list', {}));
    });

    expect(tools).toContain('workday_healthcheck');
    expect(tools).toContain('workday_get_apps');
    expect(tools).toContain('workday_get_task');
    expect(tools.length).toBeGreaterThanOrEqual(3);
  });
});
