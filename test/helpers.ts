import { DEFAULT_STATE, EMPTY_LIMIT, type LimitState, type State } from '../src/types';

const LIMIT_KEYS = ['pct', 'resetsAt', 'updatedAt', 'disarmedUntil', 'pausePromptInjectedTo'] as const;

/**
 * Flat fields describe the session limit, as most tests only care about one; `weekly` sets the
 * other. Everything else is the shared state, as usual.
 */
export type StateOverrides = Partial<LimitState> &
  Partial<Omit<State, 'limits'>> & { weekly?: Partial<LimitState> };

export function stateWith(overrides: StateOverrides = {}, base: State = DEFAULT_STATE): State {
  const { weekly, ...rest } = overrides;
  const session: Partial<LimitState> = {};
  const shared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((LIMIT_KEYS as readonly string[]).includes(key)) (session as Record<string, unknown>)[key] = value;
    else shared[key] = value;
  }
  return {
    ...base,
    ...(shared as Partial<State>),
    limits: {
      session: { ...EMPTY_LIMIT, ...base.limits.session, ...session },
      weekly: { ...EMPTY_LIMIT, ...base.limits.weekly, ...weekly },
    },
  };
}
