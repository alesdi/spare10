import { describe, expect, it } from 'vitest';
import { diagnose, formatClock, formatDuration } from '../src/doctor';
import { DEFAULT_CONFIG, DEFAULT_STATE, type State } from '../src/types';

const NOW = 1_000_000;
const state = (overrides: Partial<State> = {}): State => ({
  ...DEFAULT_STATE,
  pct: 40,
  resetsAt: NOW + 3600,
  updatedAt: NOW,
  ...overrides,
});

describe('diagnose', () => {
  it.each([
    ['no-data', state({ pct: null })],
    ['blind', state({ blind: true })],
    ['stale', state({ updatedAt: NOW - 100 })],
    ['disarmed', state({ pct: 95, disarmedUntil: NOW + 10 })],
    ['tripped', state({ pct: 95 })],
    ['armed', state({ pct: 40 })],
  ] as const)('reports %s', (expected, input) => {
    expect(diagnose(input, DEFAULT_CONFIG, NOW).status).toBe(expected);
  });

  it('reports remaining headroom while armed', () => {
    expect(diagnose(state({ pct: 72 }), DEFAULT_CONFIG, NOW).detail).toContain('18 points');
  });

  it('describes staleness as an ended session rather than a fault', () => {
    const verdict = diagnose(state({ updatedAt: NOW - 600 }), DEFAULT_CONFIG, NOW);
    expect(verdict.detail).toContain('no active session');
  });

  it('agrees with the threshold boundary used by the gate', () => {
    expect(diagnose(state({ pct: 89 }), DEFAULT_CONFIG, NOW).status).toBe('armed');
    expect(diagnose(state({ pct: 90 }), DEFAULT_CONFIG, NOW).status).toBe('tripped');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [90, '1m'],
    [3600, '1h 0m'],
    [10560, '2h 56m'],
    [-30, '30s'],
  ])('formats %i seconds as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});

describe('formatClock', () => {
  it('renders a wall-clock time', () => {
    expect(formatClock(1789041600)).toMatch(/^\d{1,2}:\d{2}/);
  });
});
