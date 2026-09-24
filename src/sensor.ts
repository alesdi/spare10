import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isIntoReserve } from './decide';
import { parseStatuslinePayload, type QuotaWindow, type StatuslinePayload } from './payload';
import { readRunConfig, readState, writeState, nowSeconds } from './state';
import {
  BLIND_DEBOUNCE,
  DEFAULT_RESERVE,
  LIMITS,
  type LimitState,
  type RunConfig,
  type State,
} from './types';

/**
 * Fold one limit's reading into what we knew of it.
 *
 * A changed reset timestamp means a new window for this limit: its consent and pause-prompt
 * bookkeeping start over. The other limit's window is none of its business.
 */
function advanceLimit(prev: LimitState, window: QuotaWindow | undefined, now: number): LimitState {
  if (!window) return prev;
  const rolledOver =
    window.resetsAt !== null && prev.resetsAt !== null && window.resetsAt !== prev.resetsAt;
  return {
    pct: window.usedPercentage,
    resetsAt: window.resetsAt,
    updatedAt: now,
    disarmedUntil: rolledOver ? null : prev.disarmedUntil,
    pausePromptInjectedTo: rolledOver ? [] : prev.pausePromptInjectedTo,
  };
}

/**
 * Fold one statusline payload into the persisted state.
 *
 * `updatedAt` advances only on a *valid* reading, so the gate's staleness check measures
 * "how long since we last knew the quota", not "how long since the sensor last ran".
 *
 * Only a payload with no limit at all counts towards going blind. One limit missing is a plan
 * that does not report it, and that limit simply stays unknown — which the gate reads as pass.
 */
export function advanceState(prev: State, payload: StatuslinePayload, now: number): State {
  const tick = prev.tick + 1;
  // The header fields are absent from some payloads; keep the last ones we saw rather than
  // letting the prompt lose the session's identity to one thin poll.
  const session = payload.session ?? prev.session;

  if (LIMITS.every((limit) => !payload.windows[limit])) {
    const missingStreak = prev.missingStreak + 1;
    return { ...prev, tick, session, missingStreak, blind: missingStreak >= BLIND_DEBOUNCE };
  }

  return {
    tick,
    session,
    limits: {
      session: advanceLimit(prev.limits.session, payload.windows.session, now),
      weekly: advanceLimit(prev.limits.weekly, payload.windows.weekly, now),
    },
    missingStreak: 0,
    blind: false,
    halted: prev.halted,
  };
}

/**
 * Colours, and a pulse driven by our own render cadence.
 *
 * SGR 5 (blink) is ignored by most terminals, so the icon is alternated with a same-width
 * space on each sensor run instead. The sensor fires once per refresh interval, so the
 * tick counter alternates reliably no matter how the terminal feels about blinking.
 */
const ORANGE = '\u001b[38;5;208m';
const GREEN = '\u001b[38;5;40m';
const GRAY = '\u001b[38;5;245m';
const RESET = '\u001b[39m';
const orange = (text: string) => `${ORANGE}${text}${RESET}`;
const green = (text: string) => `${GREEN}${text}${RESET}`;
const gray = (text: string) => `${GRAY}${text}${RESET}`;

/**
 * The name already says 10, so the reserve is only spelled out when it is not 10 — as one
 * figure when both limits share it, and by name when they do not.
 */
export function label(config: RunConfig): string {
  const { session, weekly } = config.reserve;
  if (session === weekly) return session === DEFAULT_RESERVE ? 'spare10' : `spare10 (${session}%)`;
  return `spare10 (session ${session}%, weekly ${weekly}%)`;
}

/**
 * A small coloured marker says at a glance which state the breaker is in: gray while waiting
 * for the first reading, green while the reserve is untouched, orange once you have consented
 * to eat into it, a steady pause mark once the pause prompt has gone out, and the pulsing
 * warning in between. `spare10 doctor` remains the deeper "is it wired up?" affordance.
 *
 * This is the only channel that reliably reaches the user mid-session: a hook's plain output
 * becomes context for the model, which paraphrases it, and its one user-visible path is exit
 * code 2, which erases whatever the user had typed.
 */
export function renderBadge(state: State, config: RunConfig, now: number): string {
  if (!config.badge) return '';
  if (state.blind) return '⚠ spare10 quota unavailable';
  if (LIMITS.every((limit) => state.limits[limit].pct === null)) return gray(`⧗ ${label(config)}`);

  const into = LIMITS.filter((limit) => isIntoReserve(state, config, limit, now));
  if (into.length === 0) return green(`● ${label(config)}`);

  const holding = into.filter((limit) => {
    const until = state.limits[limit].disarmedUntil;
    return until === null || now >= until;
  });
  if (holding.length === 0) return orange(`⨯ ${label(config)}`);

  // The pause prompt has gone out: the breaker is no longer *about* to pause — it has. (A hard
  // stop needs no mark of its own; the process it would decorate is gone.)
  if (holding.every((limit) => state.limits[limit].pausePromptInjectedTo.length > 0)) {
    return orange(`⏸ ${label(config)}`);
  }

  const icon = state.tick % 2 === 0 ? '⚠' : ' ';
  return orange(`${icon} Pausing at next tool call`);
}

/** Run the user's original statusLine command with the untouched payload on its stdin. */
function chain(command: string | null, raw: string): string {
  if (!command || command.includes('spare10 sensor')) return '';
  try {
    const result = spawnSync(command, {
      shell: true,
      input: raw,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_000_000,
    });
    return (result.stdout ?? '').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function runSensor(runDir: string): number {
  const raw = readStdin();
  const config = readRunConfig(runDir);
  const next = advanceState(readState(runDir), parseStatuslinePayload(raw), nowSeconds());
  writeState(runDir, next);

  const parts = [renderBadge(next, config, nowSeconds()), chain(config.chain, raw)].filter(Boolean);
  if (parts.length > 0) process.stdout.write(parts.join('  '));
  return 0;
}
