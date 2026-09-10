/**
 * Tolerant parsing of the statusLine stdin payload.
 *
 * Every field is optional by design: this schema is undocumented, Anthropic changes it
 * without notice, and `rate_limits` is absent on the first invocation of every session
 * (and entirely absent on some plans). Anything unparseable yields nulls so the caller
 * can fail open.
 */

export interface FiveHourWindow {
  /** Integer 0-100. The API reports whole percentages only. */
  usedPercentage: number;
  /** Epoch seconds, or null if absent. */
  resetsAt: number | null;
}

export interface StatuslinePayload {
  sessionId: string | null;
  fiveHour: FiveHourWindow | null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseStatuslinePayload(raw: string): StatuslinePayload {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return { sessionId: null, fiveHour: null };
  }
  if (typeof root !== 'object' || root === null) return { sessionId: null, fiveHour: null };

  const obj = root as Record<string, unknown>;
  const sessionId = typeof obj['session_id'] === 'string' ? obj['session_id'] : null;

  const limits = obj['rate_limits'];
  if (typeof limits !== 'object' || limits === null) return { sessionId, fiveHour: null };

  const window = (limits as Record<string, unknown>)['five_hour'];
  if (typeof window !== 'object' || window === null) return { sessionId, fiveHour: null };

  const w = window as Record<string, unknown>;
  const pct = asFiniteNumber(w['used_percentage']);
  if (pct === null) return { sessionId, fiveHour: null };

  return {
    sessionId,
    fiveHour: {
      usedPercentage: Math.min(100, Math.max(0, pct)),
      resetsAt: asFiniteNumber(w['resets_at']),
    },
  };
}
