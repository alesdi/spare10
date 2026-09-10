/** Persisted quota state for one spare10 run. All fields tolerate being absent. */
export interface State {
  /** Last observed five_hour.used_percentage (0-100), or null if never seen. */
  pct: number | null;
  /** Epoch seconds when the current 5-hour window resets, or null. */
  resetsAt: number | null;
  /** Epoch seconds of the last *valid* reading. Drives staleness, not liveness. */
  updatedAt: number | null;
  /** Consecutive sensor invocations with no rate_limits in the payload. */
  missingStreak: number;
  /** True once missingStreak crosses the debounce threshold. */
  blind: boolean;
  /** Epoch seconds until which the gate stays quiet, or null. */
  disarmedUntil: number | null;
  /** Whether --pause-prompt has already been injected this window. */
  pausePromptInjected: boolean;
  /** Set when the gate emitted an `ask`; PostToolUse reads it as the approval signal. */
  awaitingApproval: boolean;
}

/** Per-run configuration, written by the launcher and read by sensor/gate/post. */
export interface RunConfig {
  /** Percentage of the 5-hour window held back for the human. Trips once usage eats into it. */
  reserve: number;
  /** Non-blocking instruction injected on trip instead of asking. */
  pausePrompt: string | null;
  /** statusLine refreshInterval in seconds; also the staleness unit. */
  refresh: number;
  /** Whether to render the spare10 badge in the status line. */
  badge: boolean;
  /** The user's original statusLine command, to chain into. */
  chain: string | null;
}

export const DEFAULT_STATE: State = {
  pct: null,
  resetsAt: null,
  updatedAt: null,
  missingStreak: 0,
  blind: false,
  disarmedUntil: null,
  pausePromptInjected: false,
  awaitingApproval: false,
};

/** The reserve the tool is named after. Shown in the status line only when overridden. */
export const DEFAULT_RESERVE = 10;

export const DEFAULT_CONFIG: RunConfig = {
  reserve: DEFAULT_RESERVE,
  pausePrompt: null,
  refresh: 5,
  badge: true,
  chain: null,
};

/** rate_limits payloads go missing on the first invocation of every session. */
export const BLIND_DEBOUNCE = 3;

/** State older than this many refresh intervals is treated as unknown, and the gate opens. */
export const STALE_REFRESH_MULTIPLE = 3;

/** Fallback disarm span when resets_at is unknown, in seconds. */
export const FALLBACK_DISARM_SECONDS = 3600;

/** Usage percentage at which the reserve starts being consumed. */
export function tripPoint(config: Pick<RunConfig, 'reserve'>): number {
  return 100 - config.reserve;
}

/** Quota still untouched, as a percentage. */
export function remaining(pct: number): number {
  return 100 - pct;
}
