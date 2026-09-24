import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceState, renderBadge } from '../src/sensor';
import { parseStatuslinePayload } from '../src/payload';
import { readRunConfig, readState, writeState } from '../src/state';
import { DEFAULT_STATE, DEFAULT_CONFIG, EMPTY_LIMIT, type RunConfig } from '../src/types';
import { stateWith as state } from './helpers';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8');

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('parseStatuslinePayload', () => {
  it('extracts both windows from a real payload', () => {
    const parsed = parseStatuslinePayload(fixture('statusline.with-rate-limits'));
    expect(parsed.windows).toEqual({
      session: { usedPercentage: 4, resetsAt: 1789041600 },
      weekly: { usedPercentage: 64, resetsAt: 1789257600 },
    });
    expect(parsed.sessionId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('has no windows for the first payload of a session, which carries no rate_limits', () => {
    const parsed = parseStatuslinePayload(fixture('statusline.no-rate-limits'));
    expect(parsed.windows).toEqual({});
    expect(parsed.sessionId).not.toBeNull();
  });

  it('reads one window when the plan reports only one', () => {
    const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 5 } } });
    expect(parseStatuslinePayload(raw).windows).toEqual({ session: { usedPercentage: 12, resetsAt: 5 } });
  });

  it.each([['not json', 'garbage'], ['null', 'null'], ['empty', '']])(
    'survives %s input',
    (_label, raw) => {
      expect(parseStatuslinePayload(raw)).toEqual({ sessionId: null, windows: {}, session: null });
    },
  );

  it('reads the session header out of a real payload', () => {
    const parsed = parseStatuslinePayload(fixture('statusline.with-rate-limits'));
    expect(parsed.session).toEqual({
      version: '2.1.267',
      model: 'Opus 5 (1M context)',
      effort: 'high',
      cwd: '/Users/example/project',
      fastMode: false,
    });
  });

  it('reads the header even from the first payload, which has no rate_limits', () => {
    expect(parseStatuslinePayload(fixture('statusline.no-rate-limits')).session?.model).toBe(
      'Opus 5 (1M context)',
    );
  });

  it('falls back to cwd when the workspace block is missing', () => {
    const raw = JSON.stringify({ cwd: '/tmp/x', version: '9.9.9' });
    expect(parseStatuslinePayload(raw).session).toMatchObject({ cwd: '/tmp/x', version: '9.9.9' });
  });

  it('has no session at all when the payload describes none', () => {
    expect(parseStatuslinePayload(JSON.stringify({ session_id: 'x' })).session).toBeNull();
  });

  it('clamps out-of-range percentages', () => {
    const raw = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 140 } } });
    expect(parseStatuslinePayload(raw).windows.session?.usedPercentage).toBe(100);
  });
});

describe('advanceState', () => {
  const reading = (pct: number, resetsAt: number | null = 1000) =>
    parseStatuslinePayload(
      JSON.stringify({ rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } } }),
    );
  const both = (session: [number, number], weekly: [number, number]) =>
    parseStatuslinePayload(
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: session[0], resets_at: session[1] },
          seven_day: { used_percentage: weekly[0], resets_at: weekly[1] },
        },
      }),
    );

  it('records a valid reading and stamps updatedAt', () => {
    const next = advanceState(state(), reading(42), 500);
    expect(next.blind).toBe(false);
    expect(next.limits.session).toMatchObject({ pct: 42, resetsAt: 1000, updatedAt: 500 });
  });

  it('records both limits from one payload', () => {
    const next = advanceState(state(), both([42, 1000], [70, 90000]), 500);
    expect(next.limits.session).toMatchObject({ pct: 42, resetsAt: 1000, updatedAt: 500 });
    expect(next.limits.weekly).toMatchObject({ pct: 70, resetsAt: 90000, updatedAt: 500 });
  });

  it('does not go blind when only the weekly limit is missing', () => {
    let current = state();
    for (let i = 0; i < 5; i += 1) current = advanceState(current, reading(42), 500);
    expect(current.blind).toBe(false);
    expect(current.missingStreak).toBe(0);
    expect(current.limits.weekly).toEqual(EMPTY_LIMIT);
  });

  it('rolls each limit over on its own', () => {
    const prev = state({
      pct: 95,
      resetsAt: 1000,
      disarmedUntil: 1000,
      pausePromptInjectedTo: ['main'],
      weekly: { pct: 95, resetsAt: 90000, disarmedUntil: 90000, pausePromptInjectedTo: ['main'] },
    });
    const sessionRolled = advanceState(prev, both([2, 19000], [96, 90000]), 1001);
    expect(sessionRolled.limits.session).toMatchObject({ disarmedUntil: null, pausePromptInjectedTo: [] });
    expect(sessionRolled.limits.weekly).toMatchObject({ disarmedUntil: 90000, pausePromptInjectedTo: ['main'] });

    const weeklyRolled = advanceState(prev, both([96, 1000], [1, 700000]), 900);
    expect(weeklyRolled.limits.session).toMatchObject({ disarmedUntil: 1000, pausePromptInjectedTo: ['main'] });
    expect(weeklyRolled.limits.weekly).toMatchObject({ disarmedUntil: null, pausePromptInjectedTo: [] });
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
    expect(next.limits.session.updatedAt).toBe(100);
    expect(next.limits.session.pct).toBe(4);
  });

  it('re-arms when the window rolls over', () => {
    const prev = state({
      pct: 97,
      resetsAt: 1000,
      disarmedUntil: 1000,
      pausePromptInjectedTo: ['main'],
    });
    const next = advanceState(prev, reading(2, 19000), 1001);
    expect(next.limits.session.disarmedUntil).toBeNull();
    expect(next.limits.session.pausePromptInjectedTo).toEqual([]);
  });

  it('preserves the disarm within the same window', () => {
    const prev = state({ pct: 91, resetsAt: 1000, disarmedUntil: 1000, pausePromptInjectedTo: ['main'] });
    const next = advanceState(prev, reading(93, 1000), 500);
    expect(next.limits.session.disarmedUntil).toBe(1000);
    expect(next.limits.session.pausePromptInjectedTo).toEqual(['main']);
  });
});

describe('advanceState session header', () => {
  const header = { version: '2.1.278', model: 'Opus 5', effort: 'high', cwd: '/x', fastMode: false };

  it('records what the session says about itself', () => {
    const next = advanceState(state(), { sessionId: 's', windows: {}, session: header }, 1000);
    expect(next.session).toEqual(header);
  });

  it('keeps the last header when a payload arrives without one', () => {
    const prev = state({ session: header });
    const next = advanceState(prev, { sessionId: 's', windows: {}, session: null }, 1000);
    expect(next.session).toEqual(header);
  });

  it('keeps it across a window rollover, which only re-arms the breaker', () => {
    const prev = state({ session: header, resetsAt: 100, pct: 99 });
    const next = advanceState(
      prev,
      { sessionId: 's', windows: { session: { usedPercentage: 1, resetsAt: 200 } }, session: null },
      1000,
    );
    expect(next.session).toEqual(header);
    expect(next.limits.session.disarmedUntil).toBeNull();
  });
});

describe('renderBadge', () => {
  /** A reading the badge can trust: inside its window at every `now` used here. */
  const seen = (overrides: Parameters<typeof state>[0] = {}) =>
    state({ resetsAt: 1000, updatedAt: 0, ...overrides });
  const reserves = (session: number, weekly: number): RunConfig => ({
    ...DEFAULT_CONFIG,
    reserve: { session, weekly },
  });

  it('names each reserve when they differ', () => {
    expect(stripAnsi(renderBadge(state(), reserves(20, 5), 0))).toBe('⧗ spare10 (session 20%, weekly 5%)');
  });

  it('turns orange when only the weekly limit is into its reserve', () => {
    const weekly = seen({ pct: 30, weekly: { pct: 95, resetsAt: 1000, updatedAt: 0 } });
    expect(stripAnsi(renderBadge(weekly, DEFAULT_CONFIG, 0))).toBe('⚠ Pausing at next tool call');
  });

  it('keeps warning while the other limit is still holding after consent to one', () => {
    const state = seen({ pct: 95, disarmedUntil: 1000, weekly: { pct: 95, resetsAt: 1000, updatedAt: 0 } });
    expect(stripAnsi(renderBadge(state, DEFAULT_CONFIG, 0))).toBe('⚠ Pausing at next tool call');
  });

  it('shows a green marker while the reserve is untouched', () => {
    const badge = renderBadge(seen({ pct: 42 }), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('● spare10');
    expect(badge).toContain('\u001b[38;5;40m');
  });

  it('shows a gray hourglass before the first reading', () => {
    const badge = renderBadge(state(), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('⧗ spare10');
    expect(badge).toContain('\u001b[38;5;245m');
  });

  it('spells out a non-default reserve while waiting', () => {
    const badge = renderBadge(state(), reserves(20, 20), 0);
    expect(stripAnsi(badge)).toBe('⧗ spare10 (20%)');
  });

  it('spells out a non-default reserve while armed', () => {
    const badge = renderBadge(seen({ pct: 42 }), reserves(20, 20), 0);
    expect(stripAnsi(badge)).toBe('● spare10 (20%)');
  });

  it('says what is about to happen, not how much is left', () => {
    const badge = renderBadge(seen({ pct: 90 }), DEFAULT_CONFIG, 0);
    expect(stripAnsi(badge)).toBe('⚠ Pausing at next tool call');
  });

  it('pulses by alternating the icon on each sensor run', () => {
    // SGR 5 is ignored by most terminals, so the pulse is driven by our own render cadence.
    const even = stripAnsi(renderBadge(seen({ pct: 90, tick: 0 }), DEFAULT_CONFIG, 0));
    const odd = stripAnsi(renderBadge(seen({ pct: 90, tick: 1 }), DEFAULT_CONFIG, 0));
    expect(even).toBe('⚠ Pausing at next tool call');
    expect(odd).toBe('  Pausing at next tool call');
    expect(even.length).toBe(odd.length); // same width, so the text never shifts
  });

  it('renders the warning in orange', () => {
    expect(renderBadge(seen({ pct: 90 }), DEFAULT_CONFIG, 0)).toContain('\u001b[38;5;208m');
  });

  it('does not use SGR 5, which most terminals ignore', () => {
    expect(renderBadge(seen({ pct: 90 }), DEFAULT_CONFIG, 0)).not.toContain('\u001b[5m');
  });

  it('goes quiet-but-present, in orange, once disarmed', () => {
    const badge = renderBadge(seen({ pct: 95, disarmedUntil: 100 }), DEFAULT_CONFIG, 50);
    expect(stripAnsi(badge)).toBe('⨯ spare10');
    expect(badge).toContain('\u001b[38;5;208m');
  });

  it('spells out a non-default reserve once disarmed', () => {
    const badge = renderBadge(seen({ pct: 99, disarmedUntil: 100 }), reserves(99, 99), 50);
    expect(stripAnsi(badge)).toBe('⨯ spare10 (99%)');
  });

  it('shows a steady pause mark once the pause prompt has gone out', () => {
    const even = renderBadge(seen({ pct: 95, pausePromptInjectedTo: ['main'], tick: 0 }), DEFAULT_CONFIG, 0);
    const odd = renderBadge(seen({ pct: 95, pausePromptInjectedTo: ['main'], tick: 1 }), DEFAULT_CONFIG, 0);
    expect(stripAnsi(even)).toBe('⏸ spare10');
    expect(stripAnsi(odd)).toBe('⏸ spare10');
    expect(even).toContain('\u001b[38;5;208m');
  });

  it('prefers the disarmed mark over the pause mark', () => {
    const badge = renderBadge(seen({ pct: 95, pausePromptInjectedTo: ['main'], disarmedUntil: 100 }), DEFAULT_CONFIG, 50);
    expect(stripAnsi(badge)).toBe('⨯ spare10');
  });

  it('leaves the blind warning plain, since it is not urgent', () => {
    const badge = renderBadge(state({ blind: true }), DEFAULT_CONFIG, 0);
    expect(badge).toBe('⚠ spare10 quota unavailable');
  });

  it('warns when the sensor is blind', () => {
    expect(renderBadge(state({ blind: true }), DEFAULT_CONFIG, 0)).toContain('unavailable');
  });

  it('renders nothing when badges are disabled', () => {
    expect(renderBadge(seen({ pct: 99 }), { ...DEFAULT_CONFIG, badge: false }, 0)).toBe('');
  });
});

describe('state persistence', () => {
  it('round-trips through an atomic write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    const written = state({ pct: 88, resetsAt: 1789041600, updatedAt: 1789020000 });
    writeState(dir, written);
    expect(readState(dir)).toEqual(written);
  });

  it('reads the layout from before the weekly limit as the session limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ pct: 88, resetsAt: 5000, updatedAt: 4000, disarmedUntil: 5000, pausePromptInjectedTo: ['x'] }),
    );
    const read = readState(dir);
    expect(read.limits.session).toEqual({
      pct: 88,
      resetsAt: 5000,
      updatedAt: 4000,
      disarmedUntil: 5000,
      pausePromptInjectedTo: ['x'],
    });
    expect(read.limits.weekly).toEqual(EMPTY_LIMIT);
  });

  it('reads a single reserve figure as the reserve for both limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ reserve: 25 }));
    expect(readRunConfig(dir).reserve).toEqual({ session: 25, weekly: 25 });
  });

  it('reads a reserve per limit, clamping each and defaulting a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ reserve: { session: 250 } }));
    expect(readRunConfig(dir).reserve).toEqual({ session: 99, weekly: 10 });
  });

  it('reads a missing or corrupt file as default state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-'));
    expect(readState(dir)).toEqual(DEFAULT_STATE);
  });
});
