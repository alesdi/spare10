/**
 * Who the paused session was, as it described itself in its status line payload.
 *
 * spare10 asks its question after Claude Code is gone from the screen, so the prompt reprints
 * the session's own header. Every field is optional: the payload is undocumented, and a header
 * line missing is better than a header line invented.
 */
export interface SessionInfo {
  version: string | null;
  /** `model.display_name`, e.g. "Opus 5 (1M context)". */
  model: string | null;
  /** `effort.level`, e.g. "high". */
  effort: string | null;
  cwd: string | null;
  fastMode: boolean;
}

export const EMPTY_SESSION: SessionInfo = {
  version: null,
  model: null,
  effort: null,
  cwd: null,
  fastMode: false,
};

/**
 * A background session the gate stopped, kept as its own file under the run directory.
 *
 * Background sessions do not run under the launcher — they live under Claude Code's daemon — so
 * there is no process to signal and no exit for the launcher to notice. The gate leaves a record
 * instead, and the launcher reads them all when it is next in front of the user.
 */
export interface StoppedSession {
  /** The session's own id, what `claude --bg --resume` takes. */
  sessionId: string;
  /** The short id `claude agents` lists, what `claude stop` and `claude attach` take. */
  backgroundId: string;
  /** How the session named itself, for the prompt. */
  name: string | null;
  cwd: string | null;
  /** Epoch seconds when it was stopped. */
  at: number;
}

/**
 * The two quota limits Claude Code reports: `five_hour` (the session limit) and `seven_day`
 * (the weekly one). Each is guarded on its own, with its own reserve, consent and rollover.
 */
export type Limit = 'session' | 'weekly';
export const LIMITS: readonly Limit[] = ['session', 'weekly'];

/** Everything spare10 knows about one limit. All fields tolerate being absent. */
export interface LimitState {
  /** Last observed used_percentage (0-100), or null if never seen. */
  pct: number | null;
  /** Epoch seconds when this limit's window resets, or null. */
  resetsAt: number | null;
  /** Epoch seconds of the last *valid* reading. Drives staleness, not liveness. */
  updatedAt: number | null;
  /**
   * Epoch seconds until which this limit stays quiet, or null. Per limit because consent is
   * given for the limit that tripped: resuming past the session limit says nothing about the
   * weekly one.
   */
  disarmedUntil: number | null;
  /**
   * Agents that have received --pause-prompt for this limit this window, by key (see
   * `agentKey`). Each agent gets the instruction once, on its first gated call, and passes
   * freely after that.
   */
  pausePromptInjectedTo: string[];
}

/** Persisted quota state for one spare10 run. All fields tolerate being absent. */
export interface State {
  limits: Record<Limit, LimitState>;
  /** Consecutive sensor invocations whose payload carried no limit at all. */
  missingStreak: number;
  /** True once missingStreak crosses the debounce threshold. */
  blind: boolean;
  /** Session id of the Claude Code process the gate stopped, so the launcher can offer to resume it. */
  halted: string | null;
  /** Increments once per sensor run. Drives the status line pulse. */
  tick: number;
  /** The running session's own header fields, for the prompt that outlives it. */
  session: SessionInfo | null;
}

/** Per-run configuration, written by the launcher and read by sensor/gate/post. */
export interface RunConfig {
  /** Percentage of each limit held back for the human. A limit trips once usage eats into it. */
  reserve: Record<Limit, number>;
  /** Non-blocking instruction injected on trip instead of asking. */
  pausePrompt: string | null;
  /** statusLine refreshInterval in seconds; also the staleness unit. */
  refresh: number;
  /** Whether to render the spare10 badge in the status line. */
  badge: boolean;
  /** The user's original statusLine command, to chain into. */
  chain: string | null;
}

export const EMPTY_LIMIT: LimitState = {
  pct: null,
  resetsAt: null,
  updatedAt: null,
  disarmedUntil: null,
  pausePromptInjectedTo: [],
};

export const DEFAULT_STATE: State = {
  limits: { session: EMPTY_LIMIT, weekly: EMPTY_LIMIT },
  missingStreak: 0,
  blind: false,
  halted: null,
  tick: 0,
  session: null,
};

/**
 * Hooks fire inside subagents too, each carrying its own `agent_id`; the main thread carries
 * none. Fold both into one key so the pause prompt can be tracked per agent.
 *
 * The session id is part of the key because one run directory can now serve many sessions: every
 * background session dispatched under the same `--settings` shares this state, and each of their
 * main threads reports no `agent_id` at all. Keyed on the agent alone, the first session to trip
 * would consume the slot and every other one would pass untouched.
 */
export const MAIN_AGENT = 'main';
export const UNKNOWN_SESSION = 'unknown';
export function agentKey(sessionId: string | null, agentId: string | null): string {
  return `${sessionId ?? UNKNOWN_SESSION}:${agentId ?? MAIN_AGENT}`;
}

/** The reserve the tool is named after, for each limit. Shown in the status line only when overridden. */
export const DEFAULT_RESERVE = 10;

/** Status line poll interval. The first payload of a session carries no rate_limits, so this
 *  is also how long spare10 is blind at startup — keep it short. */
export const DEFAULT_REFRESH = 2;

export const DEFAULT_CONFIG: RunConfig = {
  reserve: { session: DEFAULT_RESERVE, weekly: DEFAULT_RESERVE },
  pausePrompt: null,
  refresh: DEFAULT_REFRESH,
  badge: true,
  chain: null,
};

/** rate_limits payloads go missing on the first invocation of every session. */
export const BLIND_DEBOUNCE = 3;

/** State older than this many refresh intervals is treated as unknown, and the gate opens. */
export const STALE_REFRESH_MULTIPLE = 3;

/** Fallback disarm span when resets_at is unknown, in seconds. */
export const FALLBACK_DISARM_SECONDS = 3600;

/** Usage percentage at which a limit's reserve starts being consumed. */
export function tripPoint(config: Pick<RunConfig, 'reserve'>, limit: Limit): number {
  return 100 - config.reserve[limit];
}

/** Quota still untouched, as a percentage. */
export function remaining(pct: number): number {
  return 100 - pct;
}
