import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceState, renderBadge } from '../src/sensor';
import { parseStatuslinePayload } from '../src/payload';
import { readState, writeState } from '../src/state';
import { DEFAULT_STATE, DEFAULT_CONFIG, type State } from '../src/types';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8');

const state = (overrides: Partial<State> = {}): State => ({ ...DEFAULT_STATE, ...overrides });
// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('parseStatuslinePayload', () => {
  it('extracts the five-hour window from a real payload', () => {
    const parsed = parseStatuslinePayload(fixture('statusline.with-rate-limits'));
    expect(parsed.fiveHour).toEqual({ usedPercentage: 4, resetsAt: 1789041600 });
    expect(parsed.sessionId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('returns null for the first payload of a session, which carries no rate_limits', () => {
    const parsed = parseStatuslinePayload(fixture('statusline.no-rate-limits'));
    expect(parsed.fiveHour).toBeNull();
    expect(parsed.sessionId).not.toBeNull();
  });

  it.each([['not json', 'garbage'], ['null', 'null'], ['empty', '']])(
    'survives %s input',
    (_label, raw) => {
      expect(parseStatuslinePayload(raw)).toEqual({ sessionId: null, fiveHour: null });
    },
  );

  it('clamps out-of-range percentages', () => {
    const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 140 } } });
    expect(parseStatuslinePayload(raw).fiveHour?.usedPercentage).toBe(100);
  });
});

describe('advanceState', () => {
  const reading = (pct: number, resetsAt: number | null = 1000) =>
    parseStatuslinePayload(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } } }),
    );

  it('records a valid reading and stamps updatedAt', () => {
    const next = advanceState(state(), reading(42), 500);
    expect(next).toMatchObject({ pct: 42, resetsAt: 1000, updatedAt: 500, blind: false });
  });

  it('advances the pulse on every run, reading or not', () => {
    expect(advanceState(state({ tick: 7 }), reading(42), 500).tick).toBe(8);
    expect(advanceState(state({ tick: 7 }), parseStatuslinePayload('{}'), 500).tick).toBe(8);
  });

  it('goes blind only after three consecutive missing payloads', () => {
    const missing = parseStatuslinePayload('{}');
    let current = state({ pct: 4, updatedAt: 100 });
    for (const expected of [false, false, true]) {
      current = advanceState(current, missing, 200);
      expect(current.blind).toBe(expected);
    }
  });

  it('keeps updatedAt pinned to the last valid reading while blind', () => {
    const next = advanceState(state({ pct: 4, updatedAt: 100 }), parseStatuslinePayload('{}'), 900);
    expect(next.updatedAt).toBe(100);
    expect(next.pct).toBe(4);
  });

  it('re-arms when the window rolls over', () => {
    const prev = state({
      pct: 97,
      resetsAt: 1000,
      disarmedUntil: 1000,
      pausePromptInjected: true,
    });
    const next = advanceState(prev, reading(2, 19000), 1001);
    expect(next.disarmedUntil).toBeNull();
    expect(next.pausePromptInjected).toBe(false);
  });

  it('preserves the disarm within the same window', () => {
    const prev = state({ pct: 91, resetsAt: 1000, disarmedUntil: 1000, pausePromptInjected: true });
    const next = advanceState(prev, reading(93, 1000), 500);
    expect(next.disarmedUntil).toBe(1000);
    expect(next.pausePromptInjected).toBe(true);
  });
});

describe('renderBadge', () => {
  it('shows a green marker while the reserve is untouched', () => {
    const badge = renderBadge(state({ pct: 42 }), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('● spare10');
    expect(badge).toContain('\u001b[38;5;40m');
  });

  it('shows a gray hourglass before the first reading', () => {
    const badge = renderBadge(state(), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('⧗ spare10');
    expect(badge).toContain('\u001b[38;5;245m');
  });

  it('spells out a non-default reserve while waiting', () => {
    const badge = renderBadge(state(), { ...DEFAULT_CONFIG, reserve: 20 }, 0);
    expect(stripAnsi(badge)).toBe('⧗ spare10 (20%)');
  });

  it('spells out a non-default reserve while armed', () => {
    const badge = renderBadge(state({ pct: 42 }), { ...DEFAULT_CONFIG, reserve: 20 }, 0);
    expect(stripAnsi(badge)).toBe('● spare10 (20%)');
  });

  it('says what is about to happen, not how much is left', () => {
    const badge = renderBadge(state({ pct: 90 }), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('⚠ Pausing at next tool call');
  });

  it('pulses by alternating the icon on each sensor run', () => {
    // SGR 5 is ignored by most terminals, so the pulse is driven by our own render cadence.
    const even = stripAnsi(renderBadge(state({ pct: 90, tick: 0 }), DEFAULT_CONFIG, 0));
    const odd = stripAnsi(renderBadge(state({ pct: 90, tick: 1 }), DEFAULT_CONFIG, 0));
    expect(even).toBe('⚠ Pausing at next tool call');
    expect(odd).toBe('  Pausing at next tool call');
    expect(even.length).toBe(odd.length); // same width, so the text never shifts
  });

  it('renders the warning in orange', () => {
    expect(renderBadge(state({ pct: 90 }), DEFAULT_CONFIG, 0)).toContain('\u001b[38;5;208m');
  });

  it('does not use SGR 5, which most terminals ignore', () => {
    expect(renderBadge(state({ pct: 90 }), DEFAULT_CONFIG, 0)).not.toContain('\u001b[5m');
  });

  it('goes quiet-but-present, in orange, once disarmed', () => {
    const badge = renderBadge(state({ pct: 95, disarmedUntil: 100 }), DEFAULT_CONFIG, 50);
    expect(stripAnsi(badge)).toBe('⨯ spare10');
    expect(badge).toContain('\u001b[38;5;208m');
  });

  it('spells out a non-default reserve once disarmed', () => {
    const badge = renderBadge(state({ pct: 99, disarmedUntil: 100 }), { ...DEFAULT_CONFIG, reserve: 99 }, 50);
    expect(stripAnsi(badge)).toBe('⨯ spare10 (99%)');
  });

  it('leaves the blind warning plain, since it is not urgent', () => {
    const badge = renderBadge(state({ blind: true }), DEFAULT_CONFIG, 0);
    expect(badge).toBe('⚠ spare10 quota unavailable');
  });

  it('warns when the sensor is blind', () => {
    expect(renderBadge(state({ blind: true }), DEFAULT_CONFIG, 0)).toContain('unavailable');
  });

  it('renders nothing when badges are disabled', () => {
    expect(renderBadge(state({ pct: 99 }), { ...DEFAULT_CONFIG, badge: false }, 0)).toBe('');
  });
});

describe('state persistence', () => {
  it('round-trips through an atomic write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    const written = state({ pct: 88, resetsAt: 1789041600, updatedAt: 1789020000 });
    writeState(dir, written);
    expect(readState(dir)).toEqual(written);
  });

  it('reads a missing or corrupt file as default state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    expect(readState(dir)).toEqual(DEFAULT_STATE);
  });
});
