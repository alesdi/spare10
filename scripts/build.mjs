import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

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
  legalComments: 'none',
});

await chmod(outfile, 0o755);
console.log(`built ${outfile}`);
