import { formatResetTime, isReadingApplicable } from './decide';
import { remaining, tripPoint, type Limit, type RunConfig, type State } from './types';

export type Diagnosis =
  | { status: 'no-data'; detail: string }
  | { status: 'blind'; detail: string }
  | { status: 'stale'; detail: string }
  | { status: 'disarmed'; detail: string }
  | { status: 'tripped'; detail: string }
  | { status: 'armed'; detail: string };

/** Human-readable counterpart to decide(), for one limit: why it is or is not holding. */
export function diagnose(state: State, config: RunConfig, limit: Limit, now: number): Diagnosis {
  if (state.blind) {
    return { status: 'blind', detail: 'Claude Code is not reporting rate_limits on this plan' };
  }
  const reading = state.limits[limit];
  if (reading.pct === null || reading.updatedAt === null) {
    return { status: 'no-data', detail: 'no quota reading yet — start a session and wait a moment' };
  }
  if (!isReadingApplicable(reading, config, now)) {
    return { status: 'stale', detail: 'the window this reading described has already reset' };
  }
  if (reading.disarmedUntil !== null && now < reading.disarmedUntil) {
    return { status: 'disarmed', detail: `consent given; quiet until ${formatClock(reading.disarmedUntil, now)}` };
  }
  const reserve = config.reserve[limit];
  if (reading.pct >= tripPoint(config, limit)) {
    const told = reading.pausePromptInjectedTo.length;
    const suffix = told > 0 ? `; pause prompt delivered to ${told} agent${told === 1 ? '' : 's'}` : '';
    return { status: 'tripped', detail: `into the ${reserve}% reserve${suffix}` };
  }
  return {
    status: 'armed',
    detail: `${remaining(reading.pct)}% left, of which ${reserve}% is reserved`,
  };
}

export function formatDuration(seconds: number): string {
  const abs = Math.abs(Math.round(seconds));
  if (abs < 60) return `${abs}s`;
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A time of day, with the weekday once it is more than a day out. */
export const formatClock = (epochSeconds: number, now?: number): string =>
  formatResetTime(epochSeconds, now);
