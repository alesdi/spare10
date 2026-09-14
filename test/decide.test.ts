import { describe, expect, it } from 'vitest';
import { decide, formatResetTime, isTripped, type Decision } from '../src/decide';
import { DEFAULT_CONFIG, DEFAULT_STATE, MAIN_AGENT, type RunConfig, type State } from '../src/types';

const NOW = 1_000_000;

/** A tripped-but-healthy baseline: fresh reading, at the threshold, nothing disarmed. */
const tripped = (overrides: Partial<State> = {}): State => ({
  ...DEFAULT_STATE,
  pct: 92,
  resetsAt: NOW + 3600,
  updatedAt: NOW,
  ...overrides,
});

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
    const wide = config({ reserve: 40 });
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
    expect(decision.reason).toContain('8% of quota left');
    expect(decision.reason).toContain('into your 10% reserve');
    expect(decision.reason).toContain('Do not call any further tools');
    expect(decision.reason).toMatch(/resets \d{1,2}:\d{2}/i);
  });

  it('injects the pause prompt instead of asking, when one is configured', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Commit and stop.' }));
    expect(decision.kind).toBe('inject');
    if (decision.kind !== 'inject') return;
    expect(decision.text).toContain('Commit and stop.');
    expect(decision.text).toContain('8% of quota left');
  });

  it('frames the instruction so the agent knows who is asking and why', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Open a draft PR, then wait.' }));
    if (decision.kind !== 'inject') throw new Error('expected an injection');

    // Without a preamble the instruction arrives mid-turn with no context at all.
    expect(decision.text).toMatch(/^spare10 budget guard\./);
    expect(decision.text).toContain('safe usage limit for this session');
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
  it('renders a wall-clock time', () => {
    expect(formatResetTime(1789041600)).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('degrades gracefully when the reset time is unknown', () => {
    expect(formatResetTime(null)).toBe('an unknown time');
  });
});
