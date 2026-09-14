import { execFileSync } from 'node:child_process';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { diagnose, formatClock, formatDuration } from './doctor';
import { claudeSettingsPath, runsRoot, selfPath } from './launch';
import { readChainTarget } from './settings';
import { nowSeconds, readRunConfig, readState } from './state';

declare const __SPARE10_VERSION__: string;
const VERSION = typeof __SPARE10_VERSION__ === 'string' ? __SPARE10_VERSION__ : 'dev';

const MARK = { ok: '✓', warn: '⚠', info: '·' } as const;

function latestRun(root: string): string | null {
  try {
    const runs = readdirSync(root)
      .map((entry) => join(root, entry))
      .filter((path) => {
        try {
          return statSync(path).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

function which(command: string): string | null {
  try {
    return execFileSync('command', ['-v', command], { shell: true, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function claudeVersion(): string | null {
  try {
    return execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runDoctor(): number {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const now = nowSeconds();
  let problems = 0;

  out(`spare10 ${VERSION}`);
  out();
  out('Environment');
  out(`  ${MARK.info} node       ${process.execPath} (${process.version})`);
  out(`  ${MARK.info} spare10    ${selfPath()}`);

  const claudePath = which('claude');
  const version = claudePath ? claudeVersion() : null;
  if (claudePath && version) {
    out(`  ${MARK.ok} claude     ${claudePath} (${version})`);
  } else {
    problems += 1;
    out(`  ${MARK.warn} claude     not found on PATH — spare10 has nothing to wrap`);
  }

  out();
  out('Status line');
  const chain = readChainTarget(claudeSettingsPath());
  if (chain.command === null) {
    out(`  ${MARK.info} nothing to chain — spare10 will own the status line`);
  } else {
    const binary = chain.command.split(/\s+/)[0] ?? '';
    const usable = isExecutable(binary);
    if (!usable) problems += 1;
    out(`  ${usable ? MARK.ok : MARK.warn} chains into ${chain.command}`);
    if (!usable) out(`               that path is not executable; its output will be dropped`);
  }

  out();
  const runDir = latestRun(runsRoot());
  if (runDir === null) {
    out('No runs yet. Start one with:  spare10 claude');
    return problems > 0 ? 1 : 0;
  }

  const config = readRunConfig(runDir);
  const state = readState(runDir);
  const verdict = diagnose(state, config, now);

  out(`Latest run  ${runDir}`);
  out(`  ${MARK.info} reserve       ${config.reserve}% of the 5-hour window`);
  out(
    `  ${MARK.info} on trip       ${
      config.pausePrompt === null
        ? 'stop the session and ask in the terminal'
        : `inject: ${JSON.stringify(config.pausePrompt)}`
    }`,
  );
  out(`  ${MARK.info} refresh       ${config.refresh}s`);

  if (state.pct !== null && state.updatedAt !== null) {
    out(`  ${MARK.ok} quota         ${state.pct}% used, ${100 - state.pct}% left`);
    const age = now - state.updatedAt;
    out(
      `  ${MARK.info} last reading  ${formatDuration(age)} ago` +
        (age > config.refresh * 3 ? ' (no session running; still valid for this window)' : ''),
    );
  }
  if (state.resetsAt !== null) {
    out(`  ${MARK.info} resets        ${formatClock(state.resetsAt)} (in ${formatDuration(state.resetsAt - now)})`);
  }

  // Only a blind sensor is a fault. A stale reading just means no session is running, and
  // a tripped breaker means spare10 is doing exactly its job.
  const faulty = verdict.status === 'blind';
  if (faulty) problems += 1;
  const mark = faulty ? MARK.warn : verdict.status === 'no-data' ? MARK.info : MARK.ok;
  out(`  ${mark} state         ${verdict.status.toUpperCase()} — ${verdict.detail}`);

  return problems > 0 ? 1 : 0;
}
