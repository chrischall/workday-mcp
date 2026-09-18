import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

export function bundleOptions() {
  // SDK v2 imports zod/v4 as ESM, whose class initialization is broken when
  // bundled directly by esbuild. Resolve the CommonJS export through Node so
  // the alias works with hoisted or nested installs.
  const zodV4Cjs = require.resolve('zod/v4', { paths: [process.cwd()] });
  return {
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { 'zod/v4': zodV4Cjs },
    banner: {
      js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
    },
    outfile: 'dist/bundle.js',
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await build(bundleOptions());
}
