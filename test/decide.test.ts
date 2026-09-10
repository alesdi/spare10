import { describe, expect, it } from 'vitest';
import { decide, formatResetTime, type Decision } from '../src/decide';
import { DEFAULT_CONFIG, DEFAULT_STATE, type RunConfig, type State } from '../src/types';

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

const run = (state: State, cfg = config(), permissionMode: string | null = 'default'): Decision =>
  decide({ state, config: cfg, now: NOW, permissionMode });

describe('decide — fail-open branches', () => {
  it.each([
    ['no reading has ever landed', tripped({ pct: null })],
    ['no timestamp on the reading', tripped({ updatedAt: null })],
    ['the sensor has gone blind', tripped({ blind: true })],
    ['the reading is stale', tripped({ updatedAt: NOW - DEFAULT_CONFIG.refresh * 3 - 1 })],
    ['the user already consented', tripped({ disarmedUntil: NOW + 1 })],
  ])('passes when %s', (_label, state) => {
    expect(run(state).kind).toBe('pass');
  });

  it('passes while the reserve is untouched', () => {
    expect(run(tripped({ pct: 89 })).kind).toBe('pass');
  });

  it('trips on the first point of the reserve, not one past it', () => {
    expect(run(tripped({ pct: 90 })).kind).toBe('ask');
  });

  it('follows a non-default reserve', () => {
    const wide = config({ reserve: 40 });
    expect(decide({ state: tripped({ pct: 59 }), config: wide, now: NOW, permissionMode: 'default' }).kind).toBe('pass');
    expect(decide({ state: tripped({ pct: 60 }), config: wide, now: NOW, permissionMode: 'default' }).kind).toBe('ask');
  });

  it('re-arms once the disarm window has elapsed', () => {
    expect(run(tripped({ disarmedUntil: NOW })).kind).toBe('ask');
  });

  it('treats a reading at exactly the staleness limit as fresh', () => {
    expect(run(tripped({ updatedAt: NOW - DEFAULT_CONFIG.refresh * 3 })).kind).toBe('ask');
  });
});

describe('decide — tripped behaviour', () => {
  it('asks the human by default', () => {
    const decision = run(tripped());
    expect(decision.kind).toBe('ask');
    if (decision.kind !== 'ask') return;
    expect(decision.reason).toContain('8% of the 5-hour window left');
    expect(decision.reason).toContain('10% reserve');
    expect(decision.reason).toMatch(/resets at \d{1,2}:\d{2}/i);
  });

  it('injects the pause prompt instead of asking, when one is configured', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Commit and stop.' }));
    expect(decision.kind).toBe('inject');
    if (decision.kind !== 'inject') return;
    expect(decision.text).toContain('Commit and stop.');
    expect(decision.text).toContain('8% of the 5-hour window left');
  });

  it('does not re-inject a pause prompt that already fired', () => {
    const decision = run(tripped({ pausePromptInjected: true }), config({ pausePrompt: 'Stop.' }));
    expect(decision.kind).toBe('ask');
  });

  it.each(['bypassPermissions', 'dontAsk'])(
    'denies instead of asking in %s mode, where ask would be auto-approved',
    (mode) => {
      const decision = run(tripped(), config(), mode);
      expect(decision.kind).toBe('deny');
      if (decision.kind !== 'deny') return;
      expect(decision.reason).toContain('Do not call any further tools');
    },
  );

  it.each(['default', 'plan', 'acceptEdits', 'auto', null])(
    'still asks in %s mode',
    (mode) => {
      expect(run(tripped(), config(), mode).kind).toBe('ask');
    },
  );

  it('prefers the pause prompt over the deny fallback in non-interactive modes', () => {
    const decision = run(tripped(), config({ pausePrompt: 'Wind down.' }), 'bypassPermissions');
    expect(decision.kind).toBe('inject');
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
