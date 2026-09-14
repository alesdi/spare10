import { remaining, STALE_REFRESH_MULTIPLE, tripPoint, type RunConfig, type State } from './types';

/**
 * `halt` stops the Claude Code process outright; the launcher then asks the human in the
 * terminal and resumes the session if they say so. `reason` is what the model is told when the
 * process cannot be stopped and the gate has to fall back to denying the call.
 */
export type Decision =
  | { kind: 'pass' }
  | { kind: 'inject'; text: string }
  | { kind: 'halt'; reason: string };

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
 * Usage only ever rises within a 5-hour window, so an old reading is a *lower bound* on
 * current usage — never an overstatement. Expiring it on a short timer was wrong twice over:
 * it opened the gate during any gap in status line rendering, and it tied correctness to the
 * poll interval. Once the window resets the figure describes a spent window, so it is dropped.
 *
 * With no reset timestamp there is nothing to anchor to, so fall back to the poll interval.
 */
export function isReadingApplicable(state: State, config: RunConfig, now: number): boolean {
  if (state.resetsAt !== null) return now < state.resetsAt;
  if (state.updatedAt === null) return false;
  return now - state.updatedAt <= config.refresh * STALE_REFRESH_MULTIPLE;
}

export function formatResetTime(resetsAt: number | null): string {
  if (resetsAt === null) return 'an unknown time';
  return new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The one line every spare10 message opens with, so the wording never drifts. */
export function quotaFacts(state: State, config: RunConfig): string {
  return (
    `into your ${config.reserve}% reserve · ` +
    `${remaining(state.pct ?? 0)}% of quota left · resets ${formatResetTime(state.resetsAt)}`
  );
}

export function quotaSummary(state: State, config: RunConfig): string {
  return `spare10 — ${quotaFacts(state, config)}`;
}

/**
 * What the agent receives when a pause prompt is configured.
 *
 * The user's instruction arrives with no context otherwise — mid-turn, an agent told to
 * "commit and stop" has no idea who is asking or why, and may reasonably ignore it. The
 * preamble names the source, states the situation, and only then hands over the instruction.
 */
export function pauseInstruction(state: State, config: RunConfig): string {
  return (
    `spare10 budget guard. You have reached the safe usage limit for this session ` +
    `(${quotaFacts(state, config)}). Immediately wrap up your work and stop. Immediately stop any subagent, unless the user instructs otherwise.\n\n` +
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
  if (state.pct === null || state.updatedAt === null) return PASS;
  if (state.blind) return PASS;
  if (!isReadingApplicable(state, config, now)) return PASS;
  if (state.disarmedUntil !== null && now < state.disarmedUntil) return PASS;
  if (state.pct < tripPoint(config)) return PASS;

  // Every agent — the main thread and each subagent — gets the instruction once. Hook
  // context reaches only the agent whose call it rode in on, so injecting once per session
  // would leave every other agent running unconstrained.
  if (config.pausePrompt !== null) {
    if (agent !== null && state.pausePromptInjectedTo.includes(agent)) return PASS;
    return { kind: 'inject', text: pauseInstruction(state, config) };
  }

  return {
    kind: 'halt',
    reason:
      `${quotaSummary(state, config)}. Stop now and wait for the user. ` +
      `Do not call any further tools.`,
  };
}
