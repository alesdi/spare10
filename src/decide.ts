import {
  LIMITS,
  remaining,
  STALE_REFRESH_MULTIPLE,
  tripPoint,
  type Limit,
  type LimitState,
  type RunConfig,
  type State,
} from './types';

/**
 * `halt` stops the Claude Code process outright; the launcher then asks the human in the
 * terminal and resumes the session if they say so. `reason` is what the model is told when the
 * process cannot be stopped and the gate has to fall back to denying the call. `limits` names
 * the limits that tripped, so each can be told and consented to on its own.
 */
export type Decision =
  | { kind: 'pass' }
  | { kind: 'inject'; text: string; limits: Limit[] }
  | { kind: 'halt'; reason: string; limits: Limit[] };

export interface DecideInput {
  state: State;
  config: RunConfig;
  now: number;
  /**
   * Which agent is calling (see `agentKey`); null when we have not parsed stdin yet. An
   * unknown caller never counts as already injected, so the hot path cannot wave a subagent
   * through on the main thread's behalf.
   */
  agent: string | null;
}

const PASS: Decision = { kind: 'pass' };

/**
 * A reading stays usable until its window resets.
 *
 * Usage only ever rises within a window, so an old reading is a *lower bound* on
 * current usage — never an overstatement. Expiring it on a short timer was wrong twice over:
 * it opened the gate during any gap in status line rendering, and it tied correctness to the
 * poll interval. Once the window resets the figure describes a spent window, so it is dropped.
 *
 * With no reset timestamp there is nothing to anchor to, so fall back to the poll interval.
 */
export function isReadingApplicable(limit: LimitState, config: RunConfig, now: number): boolean {
  if (limit.resetsAt !== null) return now < limit.resetsAt;
  if (limit.updatedAt === null) return false;
  return now - limit.updatedAt <= config.refresh * STALE_REFRESH_MULTIPLE;
}

/**
 * Whether a limit's usage is into its reserve, consent aside. Every uncertain reading says no:
 * a limit spare10 cannot see is a limit it leaves alone.
 */
export function isIntoReserve(state: State, config: RunConfig, limit: Limit, now: number): boolean {
  const reading = state.limits[limit];
  if (reading.pct === null || reading.updatedAt === null) return false;
  if (!isReadingApplicable(reading, config, now)) return false;
  return reading.pct >= tripPoint(config, limit);
}

const isDisarmed = (reading: LimitState, now: number) =>
  reading.disarmedUntil !== null && now < reading.disarmedUntil;

/** The limits currently holding: into their reserve, and not consented to. */
export function trippedLimits(state: State, config: RunConfig, now: number): Limit[] {
  if (state.blind) return [];
  return LIMITS.filter(
    (limit) => isIntoReserve(state, config, limit, now) && !isDisarmed(state.limits[limit], now),
  );
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * A time of day when the reset is within a day, as the session limit's always is. A weekly
 * reset is days out, so a bare "14:00" would read as today: it gets its weekday.
 */
export function formatResetTime(resetsAt: number | null, now = Math.floor(Date.now() / 1000)): string {
  if (resetsAt === null) return 'an unknown time';
  const date = new Date(resetsAt * 1000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (resetsAt - now < DAY_SECONDS) return time;
  return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** "session", "weekly", or "session and weekly". */
export function limitNames(limits: Limit[]): string {
  return limits.join(' and ');
}

/** The one line every spare10 message opens with, so the wording never drifts. */
export function quotaFacts(state: State, config: RunConfig, limits: Limit[]): string {
  return limits
    .map((limit) => {
      const reading = state.limits[limit];
      return (
        `into your ${config.reserve[limit]}% ${limit} reserve · ` +
        `${remaining(reading.pct ?? 0)}% of ${limit} quota left · ` +
        `resets ${formatResetTime(reading.resetsAt)}`
      );
    })
    .join(' — ');
}

export function quotaSummary(state: State, config: RunConfig, limits: Limit[]): string {
  return `spare10 — ${quotaFacts(state, config, limits)}`;
}

/**
 * What the agent receives when a pause prompt is configured.
 *
 * The user's instruction arrives with no context otherwise — mid-turn, an agent told to
 * "commit and stop" has no idea who is asking or why, and may reasonably ignore it. The
 * preamble names the source, states the situation, and only then hands over the instruction.
 */
export function pauseInstruction(state: State, config: RunConfig, limits: Limit[]): string {
  return (
    `spare10 budget guard. You have reached the safe ${limitNames(limits)} usage limit ` +
    `(${quotaFacts(state, config, limits)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\n` +
    `User instructions: ${config.pausePrompt ?? ''}`
  );
}

/**
 * Whether the breaker is currently holding. Used by the launcher before it starts a session,
 * which only warns and asks — it decides nothing.
 */
export function isTripped(state: State, config: RunConfig, now: number): boolean {
  return decide({ state, config, now, agent: null }).kind !== 'pass';
}

/**
 * The whole circuit breaker, as a pure function.
 *
 * Every uncertain branch returns `pass`. A quota guard that blocks a session because it lost
 * sight of the quota is worse than no guard at all, so staleness, blindness and missing data
 * all open the gate rather than closing it.
 */
export function decide({ state, config, now, agent }: DecideInput): Decision {
  const limits = trippedLimits(state, config, now);
  if (limits.length === 0) return PASS;

  // Every agent — the main thread and each subagent — gets the instruction once per limit.
  // Hook context reaches only the agent whose call it rode in on, so injecting once per session
  // would leave every other agent running unconstrained.
  if (config.pausePrompt !== null) {
    const told = (limit: Limit) =>
      agent !== null && state.limits[limit].pausePromptInjectedTo.includes(agent);
    if (limits.every(told)) return PASS;
    return { kind: 'inject', text: pauseInstruction(state, config, limits), limits };
  }

  return {
    kind: 'halt',
    reason:
      `${quotaSummary(state, config, limits)}. Stop now and wait for the user. ` +
      `Do not call any further tools.`,
    limits,
  };
}
