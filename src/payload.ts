/**
 * Tolerant parsing of the statusLine stdin payload.
 *
 * Every field is optional by design: this schema is undocumented, Anthropic changes it
 * without notice, and `rate_limits` is absent on the first invocation of every session
 * (and entirely absent on some plans). Anything unparseable yields nulls so the caller
 * can fail open.
 */

import type { SessionInfo } from './types';


export interface FiveHourWindow {
  /** Integer 0-100. The API reports whole percentages only. */
  usedPercentage: number;
  /** Epoch seconds, or null if absent. */
  resetsAt: number | null;
}

export interface StatuslinePayload {
  sessionId: string | null;
  fiveHour: FiveHourWindow | null;
  /** Null when the payload carried nothing we could use to describe the session. */
  session: SessionInfo | null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const field = (obj: Record<string, unknown>, key: string, inner: string): string | null => {
  const nested = obj[key];
  return typeof nested === 'object' && nested !== null
    ? asString((nested as Record<string, unknown>)[inner])
    : null;
};

/** The header fields, all optional. Returns null when not one of them was present. */
function parseSession(obj: Record<string, unknown>): SessionInfo | null {
  const session: SessionInfo = {
    version: asString(obj['version']),
    model: field(obj, 'model', 'display_name'),
    effort: field(obj, 'effort', 'level'),
    cwd: field(obj, 'workspace', 'current_dir') ?? asString(obj['cwd']),
    fastMode: obj['fast_mode'] === true,
  };
  const described =
    session.version !== null || session.model !== null || session.cwd !== null || session.fastMode;
  return described ? session : null;
}

export function parseStatuslinePayload(raw: string): StatuslinePayload {
  const nothing: StatuslinePayload = { sessionId: null, fiveHour: null, session: null };

  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return nothing;
  }
  if (typeof root !== 'object' || root === null) return nothing;

  const obj = root as Record<string, unknown>;
  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : null;
  const session = parseSession(obj);

  const limits = obj['rate_limits'];
  if (typeof limits !== 'object' || limits === null) return { sessionId, fiveHour: null, session };

  const window = (limits as Record<string, unknown>)['five_hour'];
  if (typeof window !== 'object' || window === null) return { sessionId, fiveHour: null, session };

  const w = window as Record<string, unknown>;
  const pct = asFiniteNumber(w['used_percentage']);
  if (pct === null) return { sessionId, fiveHour: null, session };

  return {
    sessionId,
    session,
    fiveHour: {
      usedPercentage: Math.min(100, Math.max(0, pct)),
      resetsAt: asFiniteNumber(w['resets_at']),
    },
  };
}
