import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseStatuslinePayload, type StatuslinePayload } from './payload';
import { readRunConfig, readState, writeState, nowSeconds } from './state';
import { BLIND_DEBOUNCE, type RunConfig, type State } from './types';

/**
 * Fold one statusline payload into the persisted state.
 *
 * `updatedAt` advances only on a *valid* reading, so the gate's staleness check measures
 * "how long since we last knew the quota", not "how long since the sensor last ran".
 */
export function advanceState(prev: State, payload: StatuslinePayload, now: number): State {
  const window = payload.fiveHour;

  if (!window) {
    const missingStreak = prev.missingStreak + 1;
    return { ...prev, missingStreak, blind: missingStreak >= BLIND_DEBOUNCE };
  }

  // A changed reset timestamp means a new 5-hour window: re-arm everything.
  const rolledOver =
    window.resetsAt !== null && prev.resetsAt !== null && window.resetsAt !== prev.resetsAt;

  return {
    pct: window.usedPercentage,
    resetsAt: window.resetsAt,
    updatedAt: now,
    missingStreak: 0,
    blind: false,
    disarmedUntil: rolledOver ? null : prev.disarmedUntil,
    pausePromptInjected: rolledOver ? false : prev.pausePromptInjected,
  };
}

/**
 * The status line stays empty below the threshold — spare10 is meant to be invisible until
 * it has something to say. `spare10 doctor` is the "is it running?" affordance.
 */
export function renderBadge(state: State, config: RunConfig, now: number): string {
  if (!config.badge) return '';
  if (state.blind) return '⚠ spare10: quota data unavailable';
  if (state.pct === null || state.pct < config.threshold) return '';
  const disarmed = state.disarmedUntil !== null && now < state.disarmedUntil;
  return `${disarmed ? '▶' : '⏸'} spare10 ${state.pct}%`;
}

/** Run the user's original statusLine command with the untouched payload on its stdin. */
function chain(command: string | null, raw: string): string {
  if (!command || command.includes('spare10 sensor')) return '';
  try {
    const result = spawnSync(command, {
      shell: true,
      input: raw,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return (result.stdout ?? '').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function runSensor(runDir: string): number {
  const raw = readStdin();
  const config = readRunConfig(runDir);
  const next = advanceState(readState(runDir), parseStatuslinePayload(raw), nowSeconds());
  writeState(runDir, next);

  const parts = [renderBadge(next, config, nowSeconds()), chain(config.chain, raw)].filter(Boolean);
  if (parts.length > 0) process.stdout.write(parts.join('  '));
  return 0;
}
