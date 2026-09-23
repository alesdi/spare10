import { spawnSync } from 'node:child_process';

/**
 * Claude Code's background sessions, as the CLI exposes them.
 *
 * A background session does not run under whoever started it — it lives under Claude Code's
 * daemon, reparented to init — so the launcher's pid is never on its hook's parent chain and
 * there is nothing to signal. The CLI is the only handle, and it is a different handle than the
 * one an interactive session offers: `claude agents --json` lists interactive sessions with a
 * `pid` and no short id, and background ones with a short `id` and no pid.
 */
export interface AgentsEntry {
  /** The session's own id, what `--resume` takes. */
  sessionId: string;
  /** The short id `claude stop` and `claude attach` take. Background sessions only. */
  backgroundId: string | null;
  kind: string | null;
  name: string | null;
  cwd: string | null;
}

/** How long to give the CLI. It answers in about a tenth of a second; this is only a backstop. */
const CLI_TIMEOUT_MS = 10_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Tolerant parsing of `claude agents --json`.
 *
 * Undocumented and free to change, like the status line payload, so anything unrecognisable
 * yields no entries rather than an exception: a gate that throws here would lose the tool call
 * it was asked about.
 */
export function parseAgentsListing(raw: string): AgentsEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const entries: AgentsEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const sessionId = str(obj['sessionId']);
    if (sessionId === null) continue;
    entries.push({
      sessionId,
      backgroundId: str(obj['id']),
      kind: str(obj['kind']),
      name: str(obj['name']),
      cwd: str(obj['cwd']),
    });
  }
  return entries;
}

/**
 * The background session with this id, if that is what it is.
 *
 * Both conditions are checked rather than assumed: an interactive session is listed too, and it
 * is stopped by signalling its process, not through the CLI.
 */
export function findBackground(
  entries: AgentsEntry[],
  sessionId: string,
): (AgentsEntry & { backgroundId: string }) | null {
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.kind !== 'background' || entry.backgroundId === null) return null;
    return { ...entry, backgroundId: entry.backgroundId };
  }
  return null;
}

/**
 * The records whose sessions are not currently running.
 *
 * A stopped session can be picked up by hand — `claude attach` is right there in the report —
 * and a record that outlives the stop is worse than useless: resuming a session that is already
 * running starts a *copy* of it under a new id.
 */
export function stillStopped<T extends { sessionId: string }>(records: T[], active: AgentsEntry[]): T[] {
  const running = new Set(active.map((entry) => entry.sessionId));
  return records.filter((record) => !running.has(record.sessionId));
}

function run(args: string[], cwd?: string): boolean {
  try {
    const result = spawnSync('claude', args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      stdio: 'ignore',
      ...(cwd === undefined ? {} : { cwd }),
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/** Every failure — no CLI, a timeout, garbage — reads as "no background sessions". */
export function listAgents(): AgentsEntry[] {
  try {
    const result = spawnSync('claude', ['agents', '--json'], {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    return parseAgentsListing(result.stdout);
  } catch {
    return [];
  }
}

/** Stop a background session. Its conversation is kept, so it can be resumed later. */
export function stopBackground(backgroundId: string): boolean {
  return run(['stop', backgroundId]);
}

/**
 * Put a stopped background session back in the background, under the same id.
 *
 * Deliberately flagless. A background session keeps the options it was started with, so it comes
 * back with spare10's sensor and gate already on it — and passing any flag, `--settings`
 * included, makes Claude Code start a *copy* under a new id instead of continuing this one.
 * Only the working directory is restored, and that is a property of the process, not a flag.
 */
export function resumeArgv(sessionId: string): string[] {
  return ['--bg', '--resume', sessionId];
}

export function resumeBackground(sessionId: string, cwd: string | null): boolean {
  return run(resumeArgv(sessionId), cwd ?? undefined);
}
