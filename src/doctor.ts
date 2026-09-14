import { isReadingApplicable } from './decide';
import { remaining, tripPoint, type RunConfig, type State } from './types';

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
  if (!isReadingApplicable(state, config, now)) {
    return { status: 'stale', detail: 'the window this reading described has already reset' };
  }
  if (state.disarmedUntil !== null && now < state.disarmedUntil) {
    return { status: 'disarmed', detail: `consent given; quiet until ${formatClock(state.disarmedUntil)}` };
  }
  if (state.pct >= tripPoint(config)) {
    const told = state.pausePromptInjectedTo.length;
    const suffix = told > 0 ? `; pause prompt delivered to ${told} agent${told === 1 ? '' : 's'}` : '';
    return { status: 'tripped', detail: `into the ${config.reserve}% reserve${suffix}` };
  }
  return {
    status: 'armed',
    detail: `${remaining(state.pct)}% left, of which ${config.reserve}% is reserved`,
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
