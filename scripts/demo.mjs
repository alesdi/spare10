/**
 * Show the pause prompt without running a session: bundles `scripts/demo.ts` against the real
 * `src/` and runs it. `npm run demo`, plus `-- --static`, `-- --preflight` or `-- --width 100`.
 */
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = new URL('demo.ts', import.meta.url);

const result = await build({
  entryPoints: [entry.pathname],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  write: false,
});

const dir = await mkdtemp(join(tmpdir(), 'spare10-demo-'));
const file = join(dir, 'demo.mjs');
try {
  await writeFile(file, result.outputFiles[0].text, 'utf8');
  await import(pathToFileURL(file).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
