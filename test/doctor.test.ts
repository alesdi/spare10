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
    ['stale', state({ resetsAt: NOW - 1 })],
    ['disarmed', state({ pct: 95, disarmedUntil: NOW + 10 })],
    ['tripped', state({ pct: 95 })],
    ['armed', state({ pct: 40 })],
  ] as const)('reports %s', (expected, input) => {
    expect(diagnose(input, DEFAULT_CONFIG, NOW).status).toBe(expected);
  });

  it('reports what is left, and how much of it is reserved', () => {
    const detail = diagnose(state({ pct: 72 }), DEFAULT_CONFIG, NOW).detail;
    expect(detail).toContain('28% left');
    expect(detail).toContain('10% is reserved');
  });

  it('reports a reading whose window has reset, not merely an old one', () => {
    expect(diagnose(state({ resetsAt: NOW - 1 }), DEFAULT_CONFIG, NOW).detail).toContain('already reset');
    // An old reading inside a live window is still the truth.
    expect(diagnose(state({ updatedAt: NOW - 7200 }), DEFAULT_CONFIG, NOW).status).toBe('armed');
  });

  it('agrees with the boundary used by the gate', () => {
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
