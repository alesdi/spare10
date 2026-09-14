import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, type ParsedArgs } from './args';
import { isTripped, quotaSummary } from './decide';
import { buildSettings, readChainTarget } from './settings';
import type { RunConfig } from './types';
import {
  configPath,
  disarmUntil,
  nowSeconds,
  pickSeed,
  pidPath,
  readState,
  writeState,
} from './state';

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** `SPARE10_HOME` relocates state — for tests and CI, where the real runs must not seed the new one. */
export const runsRoot = () => join(process.env['SPARE10_HOME'] ?? join(homedir(), '.spare10'), 'runs');
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

const consented = (answer: string) => /^y(es)?$/i.test(answer.trim());

export type Preflight = 'clear' | 'consented' | 'declined' | 'proceeding';

/**
 * What to do once the quota is known, separated from the terminal so it can be tested.
 *
 * `answer` is null when there is no terminal to ask — an unattended launch proceeds rather
 * than blocking on a question nobody will answer, as everywhere else here.
 */
export function preflightVerdict(tripped: boolean, answer: string | null): Preflight {
  if (!tripped) return 'clear';
  if (answer === null) return 'proceeding';
  return consented(answer) ? 'consented' : 'declined';
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

  process.stderr.write(`\n${quotaSummary(state, config)}\n`);
  return preflightVerdict(true, askTerminal('Start anyway? [y/N] '));
}

export function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * Whether a stopped session could be picked up again with `--resume`. Claude Code does not
 * write transcripts inside another Claude Code session (unless told to), nor when asked not
 * to; stopping a session that cannot be resumed would just lose it, so the gate then denies
 * the call instead.
 */
export function resumable(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.includes('--no-session-persistence')) return false;
  if (env['CLAUDE_CODE_CHILD_SESSION'] && !env['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE']) return false;
  return true;
}

/** Claude Code flags that take one value, so the value is not mistaken for a prompt. */
const VALUE_FLAGS = new Set([
  '--agent', '--agents', '--append-system-prompt', '--append-system-prompt-file', '--autocompact',
  '--debug-file', '--effort', '--environment', '--fallback-model', '--input-format', '--json-schema',
  '--max-budget-usd', '--model', '-n', '--name', '--output-format', '--permission-mode',
  '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix',
  '--setting-sources', '--settings', '--system-prompt', '--system-prompt-file',
  '--system-prompt-snapshot',
]);
/** Flags that swallow every following non-flag token, as Claude Code's own parser does. */
const VARIADIC_FLAGS = new Set([
  '--add-dir', '--allowedTools', '--allowed-tools', '--betas', '--disallowedTools',
  '--disallowed-tools', '--file', '--mcp-config', '--tools',
]);
/** Flags whose value is optional: taken when the next token is not itself a flag. */
const OPTIONAL_VALUE_FLAGS = new Set(['-d', '--debug', '--prompt-suggestions', '--remote-control']);
/** Ways of choosing *which* session to start — `--resume <id>` decides that now. */
const DROP_OPTIONAL_VALUE = new Set(['-r', '--resume', '-w', '--worktree', '--from-pr', '--teleport', '--cloud']);
const DROP_VALUE = new Set(['--session-id']);
const DROP_BARE = new Set(['-c', '--continue', '--tmux', '--bg', '--background']);

export const RESUME_PROMPT =
  'spare10 budget guard: the user stopped this session as it entered the reserve and has now ' +
  'chosen to resume it. Continue from where you left off.';

/**
 * The user's original Claude Code arguments, re-pointed at the stopped session.
 *
 * Session-selecting flags go, since `--resume <id>` now decides that; a positional prompt goes
 * too, since it was delivered the first time and our own resume prompt takes its place. Every
 * other flag is passed through so the resumed session runs the way the user set it up.
 */
export function resumeArgs(original: string[], sessionId: string): string[] {
  const kept: string[] = [];
  const at = (i: number) => original[i];
  const valueAt = (i: number) => at(i) !== undefined && !(at(i) as string).startsWith('-');

  for (let i = 0; i < original.length; i += 1) {
    const token = at(i) as string;
    if (token === '--') break; // everything after is positional
    const inline = token.startsWith('-') && token.includes('=');
    const name = inline ? (token.split('=')[0] as string) : token;

    if (DROP_BARE.has(name)) continue;
    if (DROP_VALUE.has(name)) {
      if (!inline) i += 1;
      continue;
    }
    if (DROP_OPTIONAL_VALUE.has(name)) {
      if (!inline && valueAt(i + 1)) i += 1;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      kept.push(token);
      if (!inline && at(i + 1) !== undefined) kept.push(at(++i) as string);
      continue;
    }
    if (OPTIONAL_VALUE_FLAGS.has(name)) {
      kept.push(token);
      if (!inline && valueAt(i + 1)) kept.push(at(++i) as string);
      continue;
    }
    if (VARIADIC_FLAGS.has(name)) {
      kept.push(token);
      while (!inline && valueAt(i + 1)) kept.push(at(++i) as string);
      continue;
    }
    if (token.startsWith('-')) {
      kept.push(token);
      continue;
    }
    // A bare positional: the original prompt. Already delivered.
  }

  return ['--resume', sessionId, ...kept, RESUME_PROMPT];
}

interface Exit {
  status: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

/**
 * Run Claude Code to completion, leaving its pid where the gate can find it. Async rather than
 * spawnSync only because the pid has to be on disk while the child runs.
 */
function runClaude(executable: string, args: string[], runDir: string, canResume: boolean): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: 'inherit' });
    if (canResume && child.pid !== undefined) writeFileSync(pidPath(runDir), String(child.pid));

    const done = (exit: Exit) => {
      try {
        unlinkSync(pidPath(runDir));
      } catch {
        /* never written, or already gone */
      }
      resolve(exit);
    };
    child.once('error', (error) => done({ status: null, signal: null, error }));
    child.once('exit', (status, signal) => done({ status, signal, error: null }));
  });
}

/** Claude Code catches SIGTERM and exits 143 by itself; a less graceful exit shows the signal. */
const terminated = (exit: Exit) => exit.signal === 'SIGTERM' || exit.status === 128 + 15;

function exitCode(exit: Exit): number {
  if (exit.signal) return 128 + (exit.signal === 'SIGINT' ? 2 : 15);
  return exit.status ?? 0;
}

export type Halt = 'resume' | 'declined' | 'unattended';

/** Same shape as the preflight: a null answer means nobody is there to ask. */
export function haltVerdict(answer: string | null): Halt {
  if (answer === null) return 'unattended';
  return consented(answer) ? 'resume' : 'declined';
}

export async function runLaunch({ config, command }: ParsedArgs): Promise<number> {
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
  const runConfig: RunConfig = { ...config, chain: chain.command };
  writeFileSync(configPath(runDir), JSON.stringify(runConfig, null, 2));

  const settings = JSON.stringify(
    buildSettings({
      nodePath: process.execPath,
      selfPath: selfPath(),
      runDir,
      refresh: config.refresh,
      padding: chain.padding,
    }),
  );

  const canResume = resumable(rest);
  if (!canResume) {
    process.stderr.write(
      'spare10: this session will not be saved, so it cannot be stopped and resumed; ' +
        'on trip the gate will deny tool calls instead.\n',
    );
  }

  // Claude Code owns the terminal from here. Let it handle Ctrl-C rather than dying first and
  // leaving the child orphaned with the TTY in raw mode.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);

  let args = rest;
  for (;;) {
    const exit = await runClaude(executable, ['--settings', settings, ...args], runDir, canResume);
    if (exit.error) {
      process.stderr.write(`spare10: could not start ${executable}: ${exit.error.message}\n`);
      return 127;
    }

    const state = readState(runDir);
    if (!terminated(exit) || state.halted === null) return exitCode(exit);

    // The gate stopped it. Same question as the preflight, on the same terminal.
    process.stderr.write(
      `\n${quotaSummary(state, runConfig)}\n` +
        `spare10 stopped the agent between operations — nothing is left half-written.\n`,
    );
    const halt = haltVerdict(askTerminal('Resume anyway? [y/N] '));
    if (halt !== 'resume') {
      process.stderr.write(`Not resumed. To pick it up later: claude --resume ${state.halted}\n`);
      // A declined resume is a choice, not a failure; an unattended stop reports as the kill it was.
      return halt === 'declined' ? 0 : exitCode(exit);
    }

    writeState(runDir, { ...state, halted: null, disarmedUntil: disarmUntil(state, nowSeconds()) });
    process.stderr.write('Resuming into the reserve for this window.\n\n');
    args = resumeArgs(rest, state.halted);
  }
}
