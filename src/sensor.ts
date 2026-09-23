import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseStatuslinePayload, type StatuslinePayload } from './payload';
import { readRunConfig, readState, writeState, nowSeconds } from './state';
import { BLIND_DEBOUNCE, DEFAULT_RESERVE, tripPoint, type RunConfig, type State } from './types';

/**
 * Fold one statusline payload into the persisted state.
 *
 * `updatedAt` advances only on a *valid* reading, so the gate's staleness check measures
 * "how long since we last knew the quota", not "how long since the sensor last ran".
 */
export function advanceState(prev: State, payload: StatuslinePayload, now: number): State {
  const window = payload.fiveHour;

  const tick = prev.tick + 1;
  // The header fields are absent from some payloads; keep the last ones we saw rather than
  // letting the prompt lose the session's identity to one thin poll.
  const session = payload.session ?? prev.session;

  if (!window) {
    const missingStreak = prev.missingStreak + 1;
    return { ...prev, tick, session, missingStreak, blind: missingStreak >= BLIND_DEBOUNCE };
  }

  // A changed reset timestamp means a new 5-hour window: re-arm everything.
  const rolledOver =
    window.resetsAt !== null && prev.resetsAt !== null && window.resetsAt !== prev.resetsAt;

  return {
    tick,
    session,
    pct: window.usedPercentage,
    resetsAt: window.resetsAt,
    updatedAt: now,
    missingStreak: 0,
    blind: false,
    disarmedUntil: rolledOver ? null : prev.disarmedUntil,
    pausePromptInjectedTo: rolledOver ? [] : prev.pausePromptInjectedTo,
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

/** The name already says 10, so the reserve is only spelled out when it is not 10. */
const label = (config: RunConfig) =>
  config.reserve === DEFAULT_RESERVE ? 'spare10' : `spare10 (${config.reserve}%)`;

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
  if (state.pct === null) return gray(`⧗ ${label(config)}`);
  if (state.pct < tripPoint(config)) return green(`● ${label(config)}`);

  const disarmed = state.disarmedUntil !== null && now < state.disarmedUntil;
  if (disarmed) return orange(`⨯ ${label(config)}`);

  // The pause prompt has gone out: the breaker is no longer *about* to pause — it has. (A hard
  // stop needs no mark of its own; the process it would decorate is gone.)
  if (state.pausePromptInjectedTo.length > 0) return orange(`⏸ ${label(config)}`);

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
