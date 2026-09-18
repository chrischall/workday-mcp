import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { bundleOptions } from '../scripts/bundle.mjs';

const require = createRequire(import.meta.url);

describe('scripts/bundle.mjs', () => {
  it('aliases zod/v4 to its CommonJS build (the ESM build breaks when bundled)', () => {
    const { alias } = bundleOptions();
    const target: string = alias['zod/v4'];
    expect(target).toBe(require.resolve('zod/v4'));
    expect(target).toMatch(/\.c?js$/);
    expect(target).not.toMatch(/\.mjs$/);
    expect(existsSync(target)).toBe(true);
  });

  it('bundles src/index.ts as node ESM with a require shim', () => {
    const opts = bundleOptions();
    expect(opts).toMatchObject({
      entryPoints: ['src/index.ts'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: 'dist/bundle.js',
    });
    expect(opts.banner.js).toContain('createRequire');
  });
});
