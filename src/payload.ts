/**
 * Tolerant parsing of the statusLine stdin payload.
 *
 * Every field is optional by design: this schema is undocumented, Anthropic changes it
 * without notice, and `rate_limits` is absent on the first invocation of every session
 * (and entirely absent on some plans). Anything unparseable yields nulls so the caller
 * can fail open.
 */

import type { Limit, SessionInfo } from './types';

export interface QuotaWindow {
  /** Integer 0-100. The API reports whole percentages only. */
  usedPercentage: number;
  /** Epoch seconds, or null if absent. */
  resetsAt: number | null;
}

export interface StatuslinePayload {
  sessionId: string | null;
  /** The limits this payload reported. A plan may report one and not the other. */
  windows: Partial<Record<Limit, QuotaWindow>>;
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

/** Where each limit lives under `rate_limits`. */
const WINDOW_KEYS: Record<Limit, string> = { session: 'five_hour', weekly: 'seven_day' };

function parseWindow(raw: unknown): QuotaWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const pct = asFiniteNumber(w['used_percentage']);
  if (pct === null) return null;
  return { usedPercentage: Math.min(100, Math.max(0, pct)), resetsAt: asFiniteNumber(w['resets_at']) };
}

export function parseStatuslinePayload(raw: string): StatuslinePayload {
  const nothing: StatuslinePayload = { sessionId: null, windows: {}, session: null };

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

  const windows: Partial<Record<Limit, QuotaWindow>> = {};
  const limits = obj['rate_limits'];
  if (typeof limits === 'object' && limits !== null) {
    for (const [limit, key] of Object.entries(WINDOW_KEYS) as [Limit, string][]) {
      const window = parseWindow((limits as Record<string, unknown>)[key]);
      if (window !== null) windows[limit] = window;
    }
  }
  return { sessionId, windows, session };
}
