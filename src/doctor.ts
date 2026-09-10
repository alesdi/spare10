import { STALE_REFRESH_MULTIPLE, type RunConfig, type State } from './types';

export type Diagnosis =
  | { status: 'no-data'; detail: string }
  | { status: 'blind'; detail: string }
  | { status: 'stale'; detail: string }
  | { status: 'disarmed'; detail: string }
  | { status: 'tripped'; detail: string }
  | { status: 'armed'; detail: string };

/** Human-readable counterpart to decide(): why the gate is or is not currently open. */
export function diagnose(state: State, config: RunConfig, now: number): Diagnosis {
  if (state.pct === null || state.updatedAt === null) {
    return { status: 'no-data', detail: 'no quota reading yet — start a session and wait a moment' };
  }
  if (state.blind) {
    return { status: 'blind', detail: 'Claude Code is not reporting rate_limits on this plan' };
  }
  const age = now - state.updatedAt;
  if (age > config.refresh * STALE_REFRESH_MULTIPLE) {
    return { status: 'stale', detail: `no active session; last reading ${formatDuration(age)} ago` };
  }
  if (state.disarmedUntil !== null && now < state.disarmedUntil) {
    return { status: 'disarmed', detail: `consent given; quiet until ${formatClock(state.disarmedUntil)}` };
  }
  if (state.pct >= config.threshold) {
    return { status: 'tripped', detail: `at or above the ${config.threshold}% threshold` };
  }
  return {
    status: 'armed',
    detail: `${config.threshold - state.pct} points of headroom before the threshold`,
  };
}

export function formatDuration(seconds: number): string {
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${abs}s`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
