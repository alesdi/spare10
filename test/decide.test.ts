import { describe, expect, it } from 'vitest';
import { decide, formatResetTime, isTripped, type Decision } from '../src/decide';
import { DEFAULT_CONFIG, MAIN_AGENT, type LimitState, type RunConfig, type State } from '../src/types';
import { stateWith, type StateOverrides } from './helpers';

const NOW = 1_000_000;

/** A tripped-but-healthy baseline: fresh reading, at the threshold, nothing disarmed. */
const tripped = (overrides: StateOverrides = {}): State =>
  stateWith({ pct: 92, resetsAt: NOW + 3600, updatedAt: NOW, ...overrides });

/** The weekly limit into its reserve, the session one well clear of its own. */
const weeklyTripped = (weekly: Partial<LimitState> = {}): State =>
  tripped({ pct: 30, weekly: { pct: 95, resetsAt: NOW + 3 * 86400, updatedAt: NOW, ...weekly } });

const reserves = (session: number, weekly: number) => config({ reserve: { session, weekly } });

const config = (overrides: Partial<RunConfig> = {}): RunConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

const run = (state: State, cfg = config(), agent: string | null = MAIN_AGENT): Decision =>
  decide({ state, config: cfg, now: NOW, agent });

describe('decide — fail-open branches', () => {
  it.each([
    ['no reading has ever landed', tripped({ pct: null })],
    ['no timestamp on the reading', tripped({ updatedAt: null })],
    ['the sensor has gone blind', tripped({ blind: true })],
    ['the window it described has reset', tripped({ resetsAt: NOW - 1 })],
    ['there is no window and the reading is old', tripped({ resetsAt: null, updatedAt: NOW - 999 })],
    ['the user already consented', tripped({ disarmedUntil: NOW + 1 })],
  ])('passes when %s', (_label, state) => {
    expect(run(state).kind).toBe('pass');
  });

  it('passes while the reserve is untouched', () => {
    expect(run(tripped({ pct: 89 })).kind).toBe('pass');
  });

  it('trips on the first point of the reserve, not one past it', () => {
    expect(run(tripped({ pct: 90 })).kind).toBe('halt');
  });

  it('follows a non-default reserve', () => {
    const wide = reserves(40, 40);
    expect(run(tripped({ pct: 59 }), wide).kind).toBe('pass');
    expect(run(tripped({ pct: 60 }), wide).kind).toBe('halt');
  });

  it('re-arms once the disarm window has elapsed', () => {
    expect(run(tripped({ disarmedUntil: NOW })).kind).toBe('halt');
  });

  it('still gates on an old reading while its window is open', () => {
    // Usage only rises within a window, so an old figure understates it — never the reverse.
    // Expiring it on a timer used to open the gate during any gap in status line rendering.
    expect(run(tripped({ updatedAt: NOW - 7200 })).kind).toBe('halt');
  });

  it('falls back to the poll interval when there is no window to anchor to', () => {
    const cfg = config();
    const edge = tripped({ resetsAt: null, updatedAt: NOW - cfg.refresh * 3 });
    expect(run(edge, cfg).kind).toBe('halt');
  });
});

describe('decide — tripped behaviour', () => {
  it('halts the session by default', () => {
    const decision = run(tripped());
    expect(decision.kind).toBe('halt');
    if (decision.kind !== 'halt') return;
    // The reason only reaches the model when the process could not be stopped.
    expect(decision.reason).toContain('8% of session quota left');
    expect(decision.reason).toContain('into your 10% session reserve');
    expect(decision.limits).toEqual(['session']);
    expect(decision.reason).toContain('Do not call any further tools');
    expect(decision.reason).toMatch(/resets \d{1,2}:\d{2}/i);
  });

  it('injects the pause prompt instead of asking, when one is configured', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Commit and stop.' }));
    expect(decision.kind).toBe('inject');
    if (decision.kind !== 'inject') return;
    expect(decision.text).toContain('Commit and stop.');
    expect(decision.text).toContain('8% of session quota left');
  });

  it('frames the instruction so the agent knows who is asking and why', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Open a draft PR, then wait.' }));
    if (decision.kind !== 'inject') throw new Error('expected an injection');

    // Without a preamble the instruction arrives mid-turn with no context at all.
    expect(decision.text).toMatch(/^spare10 budget guard\./);
    expect(decision.text).toContain('safe session usage limit');
    expect(decision.text).toContain('Immediately wrap up your work and stop.');
    // The user's own words come last, and verbatim.
    expect(decision.text).toContain('User instructions: Open a draft PR, then wait.');
    expect(decision.text.trimEnd().endsWith('Open a draft PR, then wait.')).toBe(true);
  });

  it('states the situation once, not twice', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Stop.' }));
    if (decision.kind !== 'inject') throw new Error('expected an injection');
    expect(decision.text.match(/spare10/g)?.length).toBe(1);
  });

  it('passes an agent that already received the pause prompt', () => {
    const told = tripped({ pausePromptInjectedTo: [MAIN_AGENT] });
    expect(run(told, config({ pausePrompt: 'Stop.' })).kind).toBe('pass');
  });

  it('injects into each agent separately, since hook context reaches only the caller', () => {
    const told = tripped({ pausePromptInjectedTo: [MAIN_AGENT] });
    expect(run(told, config({ pausePrompt: 'Stop.' }), 'agent-1').kind).toBe('inject');
    const both = tripped({ pausePromptInjectedTo: [MAIN_AGENT, 'agent-1'] });
    expect(run(both, config({ pausePrompt: 'Stop.' }), 'agent-1').kind).toBe('pass');
    expect(run(both, config({ pausePrompt: 'Stop.' }), 'agent-2').kind).toBe('inject');
  });

  it('never treats an unknown caller as already told', () => {
    // The gate's hot path decides before parsing stdin; it must not wave a subagent through.
    const told = tripped({ pausePromptInjectedTo: [MAIN_AGENT] });
    expect(run(told, config({ pausePrompt: 'Stop.' }), null).kind).toBe('inject');
  });

});

describe('decide — two limits', () => {
  it('halts on the weekly limit alone, and says so', () => {
    const decision = run(weeklyTripped());
    if (decision.kind !== 'halt') throw new Error('expected a halt');
    expect(decision.limits).toEqual(['weekly']);
    expect(decision.reason).toContain('into your 10% weekly reserve');
    expect(decision.reason).toContain('5% of weekly quota left');
    expect(decision.reason).not.toContain('session');
  });

  it('names both limits when both are into their reserve', () => {
    const decision = run(tripped({ weekly: { pct: 91, resetsAt: NOW + 86400 * 3, updatedAt: NOW } }));
    if (decision.kind !== 'halt') throw new Error('expected a halt');
    expect(decision.limits).toEqual(['session', 'weekly']);
    expect(decision.reason).toContain('session reserve');
    expect(decision.reason).toContain('weekly reserve');
  });

  it('keeps guarding the weekly limit after consent to the session one', () => {
    const state = tripped({
      disarmedUntil: NOW + 60,
      weekly: { pct: 95, resetsAt: NOW + 86400 * 3, updatedAt: NOW },
    });
    const decision = run(state);
    expect(decision.kind).toBe('halt');
    if (decision.kind === 'halt') expect(decision.limits).toEqual(['weekly']);
  });

  it('gives each limit its own reserve', () => {
    expect(run(weeklyTripped(), reserves(10, 4)).kind).toBe('pass');
    expect(run(weeklyTripped(), reserves(10, 5)).kind).toBe('halt');
    expect(run(tripped({ pct: 85 }), reserves(20, 10)).kind).toBe('halt');
  });

  it('leaves an unreported weekly limit alone', () => {
    expect(run(tripped({ pct: 30 })).kind).toBe('pass');
  });

  it('tells an agent about a limit it has not heard about yet', () => {
    const pause = config({ pausePrompt: 'Stop.' });
    // Told at the session limit; the weekly one trips afterwards.
    const state = tripped({
      pausePromptInjectedTo: [MAIN_AGENT],
      weekly: { pct: 95, resetsAt: NOW + 86400 * 3, updatedAt: NOW },
    });
    const decision = run(state, pause);
    expect(decision.kind).toBe('inject');
    const both = tripped({
      pausePromptInjectedTo: [MAIN_AGENT],
      weekly: { pct: 95, resetsAt: NOW + 86400 * 3, updatedAt: NOW, pausePromptInjectedTo: [MAIN_AGENT] },
    });
    expect(run(both, pause).kind).toBe('pass');
  });
});

describe('isTripped', () => {
  it('is quiet whenever the gate would pass', () => {
    expect(isTripped(tripped({ pct: 40 }), config(), NOW)).toBe(false);
    expect(isTripped(tripped({ disarmedUntil: NOW + 1 }), config(), NOW)).toBe(false);
  });

  it('holds while the reserve is in use', () => {
    expect(isTripped(tripped(), config(), NOW)).toBe(true);
  });
});

describe('formatResetTime', () => {
  it('renders a wall-clock time when the reset is within a day', () => {
    expect(formatResetTime(1789041600, 1789041600 - 3600)).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('adds the weekday once the reset is a day or more away', () => {
    expect(formatResetTime(1789041600, 1789041600 - 3 * 86400)).toMatch(/^\p{L}+\.? \d{1,2}:\d{2}/u);
  });

  it('degrades gracefully when the reset time is unknown', () => {
    expect(formatResetTime(null)).toBe('an unknown time');
  });
});
