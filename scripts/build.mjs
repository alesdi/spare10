import { build } from 'esbuild';
import { chmod, readFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const outfile = 'dist/spare10.js';

await build({
  entryPoints: ['src/cli.ts'],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __SPARE10_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
});

await chmod(outfile, 0o755);
console.log(`built ${outfile}`);
