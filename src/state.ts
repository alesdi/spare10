import {
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STATE,
  EMPTY_LIMIT,
  EMPTY_SESSION,
  DEFAULT_CONFIG,
  FALLBACK_DISARM_SECONDS,
  type Limit,
  type LimitState,
  type SessionInfo,
  type State,
  type RunConfig,
  type StoppedSession,
} from './types';

export const statePath = (runDir: string) => join(runDir, 'state.json');
export const configPath = (runDir: string) => join(runDir, 'config.json');
/** Pid of the Claude Code process this run launched. Absent when the session cannot be resumed. */
export const pidPath = (runDir: string) => join(runDir, 'claude.pid');
/** One file per background session the gate stopped, named for the session. */
export const stoppedDir = (runDir: string) => join(runDir, 'stopped');

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown, fallback: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === 'string') : [];
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Cosmetic only — anything unreadable just costs the prompt a header line. */
function readSession(v: unknown): SessionInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const raw = v as Record<string, unknown>;
  return {
    ...EMPTY_SESSION,
    version: str(raw['version']),
    model: str(raw['model']),
    effort: str(raw['effort']),
    cwd: str(raw['cwd']),
    fastMode: raw['fastMode'] === true,
  };
}

function readLimit(v: unknown): LimitState {
  if (typeof v !== 'object' || v === null) return { ...EMPTY_LIMIT };
  const raw = v as Record<string, unknown>;
  return {
    pct: num(raw['pct'], null),
    resetsAt: num(raw['resetsAt'], null),
    updatedAt: num(raw['updatedAt'], null),
    disarmedUntil: num(raw['disarmedUntil'], null),
    pausePromptInjectedTo: strings(raw['pausePromptInjectedTo']),
  };
}

/**
 * Both limits, from either layout. Before the weekly limit was guarded the session limit's
 * fields sat at the top level; an earlier run's state still seeds a new one, so that layout
 * reads as the session limit with nothing known about the weekly one.
 */
function readLimits(raw: Record<string, unknown>): Record<Limit, LimitState> {
  const limits = raw['limits'];
  if (typeof limits !== 'object' || limits === null) {
    return { session: readLimit(raw), weekly: { ...EMPTY_LIMIT } };
  }
  const byName = limits as Record<string, unknown>;
  return { session: readLimit(byName['session']), weekly: readLimit(byName['weekly']) };
}

/** Never throws. A corrupt or missing state file reads as the default (fail-open) state. */
export function readState(runDir: string): State {
  const raw = readJson(statePath(runDir));
  if (!raw) return { ...DEFAULT_STATE };
  return {
    limits: readLimits(raw),
    missingStreak: num(raw['missingStreak'], 0) ?? 0,
    blind: bool(raw['blind'], false),
    halted: typeof raw['halted'] === 'string' && raw['halted'] ? raw['halted'] : null,
    tick: num(raw['tick'], 0) ?? 0,
    session: readSession(raw['session']),
  };
}

/** Atomic write (tmp + rename). Never throws — a failed write just means a stale read later. */
function writeJson(dir: string, target: string, value: unknown): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(value), 'utf8');
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

export function writeState(runDir: string, state: State): void {
  writeJson(runDir, statePath(runDir), state);
}

/**
 * Record a background session the gate stopped.
 *
 * One file per session rather than a list inside `state.json`: several sessions under the same
 * run can trip within the same moment, and a read-modify-write on a shared file would drop
 * records. A dropped pause-prompt entry costs one repeated instruction; a dropped stop record
 * costs a session that vanished with no way back offered. One writer per file has no race.
 */
export function recordStopped(runDir: string, record: StoppedSession): void {
  const dir = stoppedDir(runDir);
  writeJson(dir, join(dir, `${record.sessionId}.json`), record);
}

/** Never throws. Anything unreadable is simply not listed. Oldest stop first. */
export function readStopped(runDir: string): StoppedSession[] {
  let entries: string[];
  try {
    entries = readdirSync(stoppedDir(runDir));
  } catch {
    return [];
  }
  const records: StoppedSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const raw = readJson(join(stoppedDir(runDir), entry));
    if (!raw) continue;
    const sessionId = str(raw['sessionId']);
    const backgroundId = str(raw['backgroundId']);
    if (sessionId === null || backgroundId === null) continue;
    records.push({
      sessionId,
      backgroundId,
      name: str(raw['name']),
      cwd: str(raw['cwd']),
      at: num(raw['at'], 0) ?? 0,
    });
  }
  return records.sort((a, b) => a.at - b.at);
}

/** Drop records the launcher has dealt with. A file that will not go is left for the next run. */
export function clearStopped(runDir: string, sessionIds: string[]): void {
  for (const sessionId of sessionIds) {
    try {
      unlinkSync(join(stoppedDir(runDir), `${sessionId}.json`));
    } catch {
      /* already gone */
    }
  }
}

const clampReserve = (value: number) => Math.min(99, Math.max(1, Math.round(value)));

/** One figure for both limits, as older runs wrote it, or one per limit. */
function readReserve(v: unknown): Record<Limit, number> {
  const single = num(v, null);
  if (single !== null) return { session: clampReserve(single), weekly: clampReserve(single) };
  const byName = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const one = (limit: Limit) =>
    clampReserve(num(byName[limit], DEFAULT_CONFIG.reserve[limit]) ?? DEFAULT_CONFIG.reserve[limit]);
  return { session: one('session'), weekly: one('weekly') };
}

/** Never throws. Missing or partial config falls back to defaults field by field. */
export function readRunConfig(runDir: string): RunConfig {
  const raw = readJson(configPath(runDir));
  if (!raw) return { ...DEFAULT_CONFIG };
  const refresh = num(raw['refresh'], DEFAULT_CONFIG.refresh) ?? DEFAULT_CONFIG.refresh;
  return {
    reserve: readReserve(raw['reserve']),
    pausePrompt: typeof raw['pausePrompt'] === 'string' && raw['pausePrompt'] ? raw['pausePrompt'] : null,
    refresh: Math.max(1, Math.round(refresh)),
    badge: bool(raw['badge'], DEFAULT_CONFIG.badge),
    chain: typeof raw['chain'] === 'string' && raw['chain'] ? raw['chain'] : null,
  };
}

/**
 * Record the user's consent to run into the reserve.
 *
 * Consent covers the limits that are holding right now, each until its own window resets, so the
 * breaker re-arms exactly when that quota does. A limit not yet into its reserve is left armed:
 * saying yes at the session limit is not a yes to the weekly one.
 */
export function consent(state: State, limits: Limit[], now: number): State {
  const next = { ...state.limits };
  for (const limit of limits) {
    const reading = state.limits[limit];
    next[limit] = { ...reading, disarmedUntil: reading.resetsAt ?? now + FALLBACK_DISARM_SECONDS };
  }
  return { ...state, limits: next };
}

/**
 * Choose a reading from an earlier run to start a new session with, limit by limit.
 *
 * Claude Code omits rate_limits from the first status line payload of every session, so a
 * fresh run is blind for one poll interval — long enough for the opening turn to slip past
 * the gate entirely. Quota is account-wide and only rises within a window, so the most recent
 * reading from the *same* window is a safe lower bound to open with: it can bring a trip
 * forward, never invent one.
 *
 * Only the quota figures carry over. A new session always starts armed, whatever consent the
 * previous one was given.
 */
export function pickSeed(candidates: State[], now: number): State | null {
  const seedLimit = (limit: Limit): LimitState | null => {
    let best: LimitState | null = null;
    for (const candidate of candidates) {
      const s = candidate.limits[limit];
      if (s.pct === null || s.updatedAt === null || s.resetsAt === null || s.resetsAt <= now) continue;
      if (best === null || s.updatedAt > (best.updatedAt as number)) best = s;
    }
    return best === null
      ? null
      : { ...EMPTY_LIMIT, pct: best.pct, resetsAt: best.resetsAt, updatedAt: best.updatedAt };
  };

  const session = seedLimit('session');
  const weekly = seedLimit('weekly');
  if (session === null && weekly === null) return null;
  return {
    ...DEFAULT_STATE,
    limits: { session: session ?? { ...EMPTY_LIMIT }, weekly: weekly ?? { ...EMPTY_LIMIT } },
  };
}
