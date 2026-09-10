import { STALE_REFRESH_MULTIPLE, type RunConfig, type State } from './types';

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

export function formatResetTime(resetsAt: number | null): string {
  if (resetsAt === null) return 'an unknown time';
  return new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function reasonText(state: State, config: RunConfig): string {
  return (
    `spare10 — 5-hour quota at ${state.pct}% (threshold ${config.threshold}%). ` +
    `Window resets at ${formatResetTime(state.resetsAt)}.`
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
  if (now - state.updatedAt > config.refresh * STALE_REFRESH_MULTIPLE) return PASS;
  if (state.disarmedUntil !== null && now < state.disarmedUntil) return PASS;
  if (state.pct < config.threshold) return PASS;

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
