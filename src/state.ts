import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_STATE,
  DEFAULT_CONFIG,
  FALLBACK_DISARM_SECONDS,
  type State,
  type RunConfig,
} from './types';

export const statePath = (runDir: string) => join(runDir, 'state.json');
export const configPath = (runDir: string) => join(runDir, 'config.json');

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
    pausePromptInjected: bool(raw['pausePromptInjected'], false),
    awaitingApproval: bool(raw['awaitingApproval'], false),
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
  const threshold = num(raw['threshold'], DEFAULT_CONFIG.threshold) ?? DEFAULT_CONFIG.threshold;
  const refresh = num(raw['refresh'], DEFAULT_CONFIG.refresh) ?? DEFAULT_CONFIG.refresh;
  return {
    threshold: Math.min(99, Math.max(1, Math.round(threshold))),
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
