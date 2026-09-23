import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STATE,
  EMPTY_SESSION,
  DEFAULT_CONFIG,
  FALLBACK_DISARM_SECONDS,
  type SessionInfo,
  type State,
  type RunConfig,
} from './types';

export const statePath = (runDir: string) => join(runDir, 'state.json');
export const configPath = (runDir: string) => join(runDir, 'config.json');
/** Pid of the Claude Code process this run launched. Absent when the session cannot be resumed. */
export const pidPath = (runDir: string) => join(runDir, 'claude.pid');

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

/** Never throws. A corrupt or missing state file reads as the default (fail-open) state. */
export function readState(runDir: string): State {
  const raw = readJson(statePath(runDir));
  if (!raw) return { ...DEFAULT_STATE };
  return {
    pct: num(raw['pct'], null),
    resetsAt: num(raw['resetsAt'], null),
    updatedAt: num(raw['updatedAt'], null),
    missingStreak: num(raw['missingStreak'], 0) ?? 0,
    blind: bool(raw['blind'], false),
    disarmedUntil: num(raw['disarmedUntil'], null),
    pausePromptInjectedTo: strings(raw['pausePromptInjectedTo']),
    halted: typeof raw['halted'] === 'string' && raw['halted'] ? raw['halted'] : null,
    tick: num(raw['tick'], 0) ?? 0,
    session: readSession(raw['session']),
  };
}

/** Atomic write (tmp + rename). Never throws — a failed write just means a stale read later. */
export function writeState(runDir: string, state: State): void {
  const target = statePath(runDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, target);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
  }
}

/** Never throws. Missing or partial config falls back to defaults field by field. */
export function readRunConfig(runDir: string): RunConfig {
  const raw = readJson(configPath(runDir));
  if (!raw) return { ...DEFAULT_CONFIG };
  const reserve = num(raw['reserve'], DEFAULT_CONFIG.reserve) ?? DEFAULT_CONFIG.reserve;
  const refresh = num(raw['refresh'], DEFAULT_CONFIG.refresh) ?? DEFAULT_CONFIG.refresh;
  return {
    reserve: Math.min(99, Math.max(1, Math.round(reserve))),
    pausePrompt: typeof raw['pausePrompt'] === 'string' && raw['pausePrompt'] ? raw['pausePrompt'] : null,
    refresh: Math.max(1, Math.round(refresh)),
    badge: bool(raw['badge'], DEFAULT_CONFIG.badge),
    chain: typeof raw['chain'] === 'string' && raw['chain'] ? raw['chain'] : null,
  };
}

/**
 * How long to stay quiet once the user has consented (or the pause prompt has fired).
 * Anchored to the window reset so the breaker re-arms exactly when the quota does.
 */
export function disarmUntil(state: State, now: number): number {
  return state.resetsAt ?? now + FALLBACK_DISARM_SECONDS;
}

/**
 * Choose a reading from an earlier run to start a new session with.
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
  const usable = candidates.filter(
    (s): s is State & { pct: number; resetsAt: number; updatedAt: number } =>
      s.pct !== null && s.updatedAt !== null && s.resetsAt !== null && s.resetsAt > now,
  );
  const best = usable.reduce<(State & { updatedAt: number }) | null>(
    (winner, s) => (winner === null || s.updatedAt > winner.updatedAt ? s : winner),
    null,
  );
  if (best === null) return null;
  return { ...DEFAULT_STATE, pct: best.pct, resetsAt: best.resetsAt, updatedAt: best.updatedAt };
}
