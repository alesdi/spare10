import { remaining, STALE_REFRESH_MULTIPLE, tripPoint, type RunConfig, type State } from './types';

/**
 * Permission modes in which Claude Code will not surface an `ask` dialog to a human.
 * In these, `ask` would be auto-approved and the circuit breaker would silently do nothing,
 * so we fall back to `deny`, which always blocks regardless of mode.
 */
const NON_INTERACTIVE_MODES = new Set(['bypassPermissions', 'dontAsk']);

export type Decision =
  | { kind: 'pass' }
  | { kind: 'inject'; text: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string };

export interface DecideInput {
  state: State;
  config: RunConfig;
  now: number;
  /** From the hook payload; null when we have not parsed stdin yet. */
  permissionMode: string | null;
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

/** The one sentence every spare10 message opens with, so the wording never drifts. */
export function quotaSummary(state: State, config: RunConfig): string {
  return (
    `spare10 — ${remaining(state.pct ?? 0)}% of the 5-hour window left, ` +
    `which is your ${config.reserve}% reserve. Resets at ${formatResetTime(state.resetsAt)}.`
  );
}

const reasonText = quotaSummary;

/**
 * Whether the breaker is currently holding. Used by the places that only warn — the launcher
 * before it starts a session, and the prompt-submit notice — neither of which decides anything.
 */
export function isTripped(state: State, config: RunConfig, now: number): boolean {
  return decide({ state, config, now, permissionMode: null }).kind !== 'pass';
}

/**
 * Shown when the user is about to spend a turn while the reserve is already in use.
 *
 * The gate fires on tool calls, which is what makes its stops safe: it interrupts between
 * calls rather than mid-write. Saying so here stops the pause reading like a hang.
 */
export function noticeText(state: State, config: RunConfig, atStartup = false): string {
  return (
    `${quotaSummary(state, config)} The agent will pause safely at ` +
    `${atStartup ? 'its first' : 'the next'} tool call, between operations — nothing will be ` +
    `left half-written.`
  );
}

/**
 * The whole circuit breaker, as a pure function.
 *
 * Every uncertain branch returns `pass`. A quota guard that blocks a session because it lost
 * sight of the quota is worse than no guard at all, so staleness, blindness and missing data
 * all open the gate rather than closing it.
 */
export function decide({ state, config, now, permissionMode }: DecideInput): Decision {
  if (state.pct === null || state.updatedAt === null) return PASS;
  if (state.blind) return PASS;
  if (!isReadingApplicable(state, config, now)) return PASS;
  if (state.disarmedUntil !== null && now < state.disarmedUntil) return PASS;
  if (state.pct < tripPoint(config)) return PASS;

  if (config.pausePrompt !== null && !state.pausePromptInjected) {
    return { kind: 'inject', text: `${reasonText(state, config)}\n\n${config.pausePrompt}` };
  }

  if (permissionMode !== null && NON_INTERACTIVE_MODES.has(permissionMode)) {
    return {
      kind: 'deny',
      reason:
        `${reasonText(state, config)} Stop now and wait for the user. ` +
        `Do not call any further tools.`,
    };
  }

  return { kind: 'ask', reason: `${reasonText(state, config)} Continue anyway?` };
}
