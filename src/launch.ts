import { spawn } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
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
import { listAgents, resumeBackground, stillStopped } from './background';
import { formatResetTime, limitNames, trippedLimits } from './decide';
import { tildePath, type PromptView } from './panel';
import { buildSettings, readChainTarget } from './settings';
import { ask } from './terminal';
import type { Limit, RunConfig, SessionInfo, State, StoppedSession } from './types';
import {
  clearStopped,
  configPath,
  consent,
  nowSeconds,
  pickSeed,
  pidPath,
  readState,
  readStopped,
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
 * There is no session yet at preflight, so the header says only what the launcher actually
 * knows. A model or version copied from an earlier run would be a guess printed as a fact.
 */
function launcherSession(): SessionInfo {
  return { version: null, model: null, effort: null, cwd: process.cwd(), fastMode: false };
}

/** "Weekly reserve reached." — which limit fired is the first thing worth knowing. */
function reachedHeadline(limits: Limit[]): string {
  if (limits.length === 0) return 'Reserve reached.';
  const names = limitNames(limits);
  const capitalised = `${names.charAt(0).toUpperCase()}${names.slice(1)}`;
  return `${capitalised} ${limits.length === 1 ? 'reserve' : 'reserves'} reached.`;
}

/** How long consent lasts, per limit: each one re-arms when its own window resets. */
export function quietUntil(state: State, limits: Limit[]): string {
  if (limits.length === 0) return 'spare10 stays quiet until the limit resets.';
  const times = limits.map((limit) => formatResetTime(state.limits[limit].resetsAt)).join(' and ');
  const which = limits.length === 1 ? 'limit resets' : 'limits reset';
  return `spare10 stays quiet until the ${limitNames(limits)} ${which} (${times}).`;
}

export function preflightView(state: State, config: RunConfig, limits: Limit[]): PromptView {
  const reserves = limits.map((limit) => `${config.reserve[limit]}% ${limit}`).join(' and ');
  return {
    session: launcherSession(),
    headline: 'This session would start inside the reserve.',
    body: [
      `You have less than the ${reserves} ${limits.length === 1 ? 'reserve' : 'reserves'} left. ` +
        `If you decide to start anyway, ${quietUntil(state, limits)}`,
    ],
    choices: [
      { label: 'Start anyway', hint: 'Runs now on your reserve.' },
      { label: 'Do not start', hint: 'Back to the shell.' },
    ],
  };
}

export function haltView(state: State, limits: Limit[]): PromptView {
  return {
    session: state.session,
    headline: `${reachedHeadline(limits)} The session is paused.`,
    body: [
      'spare10 stopped the agent between tool calls, so nothing is half-written and the ' +
        'whole conversation is saved.',
    ],
    choices: [
      {
        label: 'Resume',
        hint: `Continue on the reserve. ${quietUntil(state, limits)}`,
      },
      {
        label: 'Stop here',
        hint: `Back to the shell. You can still resume later with: claude --resume ${state.halted ?? ''}`,
      },
    ],
  };
}

/** How many stopped sessions the panel lists before it starts counting the rest. */
const MAX_LISTED = 5;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/**
 * The question asked once the wrapper is back in front of the user, for the background sessions
 * the gate stopped while it was away.
 *
 * There is no terminal attached to a background session, so this is the first moment spare10 can
 * ask about them at all — and it asks about all of them at once, because they all ran on the
 * same quota and the answer is the same for each.
 */
export function stoppedView(
  records: StoppedSession[],
  state: State,
  limits: Limit[],
  home = homedir(),
): PromptView {
  const listed = records.slice(0, MAX_LISTED);
  const body = [
    `spare10 stopped ${plural(records.length, 'a background session', 'background sessions')} ` +
      `at the reserve, between tool calls. Their conversations are kept.`,
    ...listed.map(
      (record) =>
        `${record.name ?? record.backgroundId} · ${tildePath(record.cwd ?? '', home)}`.trim(),
    ),
  ];
  if (records.length > listed.length) {
    body.push(`…and ${records.length - listed.length} more.`);
  }

  return {
    session: launcherSession(),
    headline: `${reachedHeadline(limits)} ${plural(records.length, 'A background session is', 'background sessions are')} paused.`,
    body,
    choices: [
      {
        label: records.length === 1 ? 'Resume' : 'Resume all',
        hint: `Back to the background, on your reserve. ${quietUntil(state, limits)}`,
      },
      {
        label: 'Leave stopped',
        hint: 'Back to the shell. Each one can still be opened with: claude attach <id>',
      },
    ],
  };
}

/**
 * Deal with whatever the gate stopped in the background while the wrapper was busy.
 *
 * Records that are not resumed are deliberately left on disk. `spare10 doctor` reads them, and
 * that is the only report there is when no wrapper was left to ask — as after `--bg`, which
 * returns as soon as the session is dispatched.
 */
async function settleStopped(runDir: string, config: RunConfig): Promise<void> {
  const all = readStopped(runDir);
  if (all.length === 0) return;

  // Anything running again was picked up by hand while we were away; its record has served its
  // purpose, and offering to resume it would start a copy of a session that never stopped.
  const records = stillStopped(all, listAgents());
  clearStopped(
    runDir,
    all.filter((record) => !records.includes(record)).map((record) => record.sessionId),
  );
  if (records.length === 0) return;

  const state = readState(runDir);
  const limits = trippedLimits(state, config, nowSeconds());
  const view = stoppedView(records, state, limits);
  if (haltVerdict(await ask({ view, state, config })) !== 'resume') {
    process.stderr.write(`Left stopped. To pick ${records.length === 1 ? 'it' : 'them'} up later:\n`);
    for (const record of records) process.stderr.write(`  claude attach ${record.backgroundId}\n`);
    return;
  }

  // Consent covers the window, exactly as it does for a session stopped in the foreground —
  // and it has to, or every resumed session would trip again on its first tool call.
  writeState(runDir, consent(state, limits, nowSeconds()));

  const resumed: string[] = [];
  for (const record of records) {
    if (resumeBackground(record.sessionId, record.cwd)) resumed.push(record.sessionId);
    else {
      process.stderr.write(
        `spare10: could not resume ${record.backgroundId}. Try: claude attach ${record.backgroundId}\n`,
      );
    }
  }
  clearStopped(runDir, resumed);
  if (resumed.length > 0) {
    process.stderr.write(
      `Resumed ${plural(resumed.length, 'one session', 'sessions')} into the reserve for this window.\n`,
    );
  }
}

/**
 * Warn before starting a session that is already into the reserve.
 *
 * Seeding means spare10 usually knows the quota before Claude Code is even launched, so the
 * cheapest stop is the one that happens before anything starts.
 */
async function preflight(runDir: string, config: RunConfig): Promise<Preflight> {
  const state = readState(runDir);
  const limits = trippedLimits(state, config, nowSeconds());
  if (limits.length === 0) return 'clear';

  const answer = await ask({ view: preflightView(state, config, limits), state, config });
  return preflightVerdict(true, answer);
}

export function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * The bundle a run's hooks should execute. The hook commands live in the `--settings` handed
 * to Claude Code, so a session that started under one version keeps calling it for its whole
 * life; if the installed bundle is upgraded meanwhile, every hook would run a subcommand set
 * that may no longer match. Each run therefore keeps its own copy of the bundle it was
 * started with, next to its state. Falls back to the installed bundle if the copy fails.
 */
export function pinSelf(runDir: string, source: string = selfPath()): string {
  const pinned = join(runDir, 'spare10.js');
  try {
    copyFileSync(source, pinned);
    return pinned;
  } catch {
    return source;
  }
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

/**
 * Claude Code's own subcommands. `claude agents` and the rest are tools, not sessions: they make
 * no tool calls of their own, there is no process for the gate to stop and nothing to resume.
 * What `claude agents` does do is dispatch background sessions, and those inherit the settings
 * spare10 hands it — so they are guarded, and the gate reaches them through the CLI instead.
 */
const SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs',
  'mcp', 'plugin', 'plugins', 'project', 'respawn', 'rm', 'setup-token', 'stop', 'kill',
  'ultrareview', 'update', 'upgrade',
]);

/**
 * The subcommand being run, or null when this is an ordinary session.
 *
 * Flag values are stepped over the same way `resumeArgs` steps over them, so `--model agents`
 * is a model named agents and not the agent view.
 */
export function subcommandOf(args: string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === '--') return null;
    if (!token.startsWith('-')) return SUBCOMMANDS.has(token) ? token : null;

    if (token.includes('=')) continue;
    const valueAt = (at: number) => args[at] !== undefined && !(args[at] as string).startsWith('-');
    if (VALUE_FLAGS.has(token) || DROP_VALUE.has(token)) i += 1;
    else if (OPTIONAL_VALUE_FLAGS.has(token) || DROP_OPTIONAL_VALUE.has(token)) {
      if (valueAt(i + 1)) i += 1;
    } else if (VARIADIC_FLAGS.has(token)) {
      while (valueAt(i + 1)) i += 1;
    }
  }
  return null;
}

/** `--bg` dispatches the session and returns, so the launcher is gone before it does anything. */
export function backgrounded(args: string[]): boolean {
  return args.includes('--bg') || args.includes('--background');
}

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
  const verdict = await preflight(runDir, { ...config, chain: null });
  if (verdict === 'declined') {
    process.stderr.write('Not started.\n');
    return 0;
  }
  if (verdict === 'consented') {
    // Consent given at the door counts for the window. Asking again on the first tool call
    // would be the same question, thirty seconds later.
    const state = readState(runDir);
    const now = nowSeconds();
    writeState(runDir, consent(state, trippedLimits(state, { ...config, chain: null }, now), now));
    process.stderr.write('Continuing into the reserve for this window.\n\n');
  }

  const chain = readChainTarget(claudeSettingsPath());
  const runConfig: RunConfig = { ...config, chain: chain.command };
  writeFileSync(configPath(runDir), JSON.stringify(runConfig, null, 2));

  const settings = JSON.stringify(
    buildSettings({
      nodePath: process.execPath,
      selfPath: pinSelf(runDir),
      runDir,
      refresh: config.refresh,
      padding: chain.padding,
    }),
  );

  // Two ways the thing we start is not the session: `claude agents` dispatches sessions rather
  // than being one, and `--bg` hands its session to the daemon and returns. Neither leaves a
  // process here to signal or a session to resume in this terminal, so neither gets a pid file
  // — the gate reaches the sessions they start, which inherit these settings, through the CLI.
  const ownsSession = subcommandOf(rest) === null && !backgrounded(rest);
  const canResume = ownsSession && resumable(rest);
  if (backgrounded(rest)) {
    process.stderr.write(
      'spare10: --bg returns as soon as the session is dispatched, so spare10 will not be here ' +
        'to ask about resuming it. It still stops the session at the reserve; ' +
        '"spare10 doctor" lists what it stopped.\n',
    );
  } else if (ownsSession && !canResume) {
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

  const code = await runForeground({ executable, rest, settings, runDir, runConfig, canResume });

  // The terminal is ours again, which is the only moment anything stopped in the background can
  // be asked about — including sessions stopped long before this one exited.
  await settleStopped(runDir, runConfig);
  return code;
}

interface ForegroundRun {
  executable: string;
  rest: string[];
  settings: string;
  runDir: string;
  runConfig: RunConfig;
  canResume: boolean;
}

/** Run Claude Code, and keep running it for as long as the user resumes what the gate stopped. */
async function runForeground(run: ForegroundRun): Promise<number> {
  const { executable, rest, settings, runDir, runConfig, canResume } = run;

  let args = rest;
  for (;;) {
    const exit = await runClaude(executable, ['--settings', settings, ...args], runDir, canResume);
    if (exit.error) {
      process.stderr.write(`spare10: could not start ${executable}: ${exit.error.message}\n`);
      return 127;
    }

    const state = readState(runDir);
    if (!terminated(exit) || state.halted === null) return exitCode(exit);

    // The gate stopped it. Same question as the preflight, in the same panel.
    const limits = trippedLimits(state, runConfig, nowSeconds());
    const halt = haltVerdict(await ask({ view: haltView(state, limits), state, config: runConfig }));
    if (halt !== 'resume') {
      process.stderr.write(`Not resumed. To pick it up later: claude --resume ${state.halted}\n`);
      // A declined resume is a choice, not a failure; an unattended stop reports as the kill it was.
      return halt === 'declined' ? 0 : exitCode(exit);
    }

    writeState(runDir, { ...consent(state, limits, nowSeconds()), halted: null });
    process.stderr.write('Resuming into the reserve for this window.\n\n');
    args = resumeArgs(rest, state.halted);
  }
}
