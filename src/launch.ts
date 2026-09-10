import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, type ParsedArgs } from './args';
import { isTripped, noticeText } from './decide';
import { buildSettings, readChainTarget } from './settings';
import type { RunConfig } from './types';
import { configPath, disarmUntil, nowSeconds, pickSeed, readState, writeState } from './state';

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const runsRoot = () => join(homedir(), '.spare10', 'runs');
export const claudeSettingsPath = () => join(homedir(), '.claude', 'settings.json');

/** Old run directories are only useful for post-mortems; drop them after a week. */
function pruneOldRuns(root: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > RUN_RETENTION_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      /* a run we cannot stat or remove is not worth failing a launch over */
    }
  }
}

/** Open the run with the newest still-valid reading from any earlier run, if there is one. */
function seedFromPreviousRuns(root: string, runDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const previous = entries
    .map((entry) => join(root, entry))
    .filter((path) => path !== runDir)
    .map(readState);

  const seed = pickSeed(previous, nowSeconds());
  if (seed !== null) writeState(runDir, seed);
}

function createRunDir(root: string): string {
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read one line straight from the terminal. Returns null when there is no terminal to ask. */
function askTerminal(question: string): string | null {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return null;
  }
  process.stderr.write(question);
  const byte = Buffer.alloc(1);
  let answer = '';
  try {
    while (readSync(fd, byte, 0, 1, null) > 0) {
      const char = byte.toString('utf8');
      if (char === '\n' || char === '\r') break;
      answer += char;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  return answer.trim();
}

export type Preflight = 'clear' | 'consented' | 'declined' | 'proceeding';

/**
 * What to do once the quota is known, separated from the terminal so it can be tested.
 *
 * `answer` is null when there is no terminal to ask — an unattended launch proceeds rather
 * than blocking on a question nobody will answer, as everywhere else here.
 */
export function preflightVerdict(
  tripped: boolean,
  hasPausePrompt: boolean,
  answer: string | null,
): Preflight {
  if (!tripped) return 'clear';
  if (hasPausePrompt) return 'proceeding';
  if (answer === null) return 'proceeding';
  return /^y(es)?$/i.test(answer.trim()) ? 'consented' : 'declined';
}

/**
 * Warn before starting a session that is already into the reserve.
 *
 * Seeding means spare10 usually knows the quota before Claude Code is even launched, so the
 * cheapest stop is the one that happens before anything starts.
 */
function preflight(runDir: string, config: RunConfig): Preflight {
  const state = readState(runDir);
  if (!isTripped(state, config, nowSeconds())) return 'clear';

  process.stderr.write(`\n${noticeText(state, config)}\n`);

  // An unattended run has already been told what to do on trip; do not stall it on a prompt.
  const answer = config.pausePrompt !== null ? null : askTerminal('Start anyway? [y/N] ');
  return preflightVerdict(true, config.pausePrompt !== null, answer);
}

export function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

export function runLaunch({ config, command }: ParsedArgs): number {
  const [executable, ...rest] = command as [string, ...string[]];

  // spare10 injects Claude Code's own settings; pointing it at anything else would hand a
  // --settings flag to a program that does not understand one.
  if (basename(executable) !== 'claude') {
    throw new UsageError(
      `spare10 wraps the "claude" command, but got "${executable}". ` +
        `Run it as: ${['spare10', ...rest, 'claude'].join(' ')}`,
    );
  }

  const root = runsRoot();
  pruneOldRuns(root, Date.now());
  const runDir = createRunDir(root);

  seedFromPreviousRuns(root, runDir);
  const verdict = preflight(runDir, { ...config, chain: null });
  if (verdict === 'declined') {
    process.stderr.write('Not started.\n');
    return 0;
  }
  if (verdict === 'consented') {
    // Consent given at the door counts for the window. Asking again on the first tool call
    // would be the same question, thirty seconds later.
    const state = readState(runDir);
    writeState(runDir, { ...state, disarmedUntil: disarmUntil(state, nowSeconds()) });
    process.stderr.write('Continuing into the reserve for this window.\n\n');
  }

  const chain = readChainTarget(claudeSettingsPath());
  writeFileSync(configPath(runDir), JSON.stringify({ ...config, chain: chain.command }, null, 2));

  const settings = buildSettings({
    nodePath: process.execPath,
    selfPath: selfPath(),
    runDir,
    refresh: config.refresh,
    padding: chain.padding,
  });

  // Claude Code owns the terminal from here. Let it handle Ctrl-C rather than dying first and
  // leaving the child orphaned with the TTY in raw mode.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);

  const result = spawnSync(executable, ['--settings', JSON.stringify(settings), ...rest], {
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`spare10: could not start ${executable}: ${result.error.message}\n`);
    return 127;
  }
  if (result.signal) return 128 + (result.signal === 'SIGINT' ? 2 : 15);
  return result.status ?? 0;
}
