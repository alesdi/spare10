import { describe, expect, it } from 'vitest';
import { diagnose, formatClock, formatDuration } from '../src/doctor';
import { DEFAULT_CONFIG, type State } from '../src/types';
import { stateWith, type StateOverrides } from './helpers';

const NOW = 1_000_000;
const state = (overrides: StateOverrides = {}): State =>
  stateWith({ pct: 40, resetsAt: NOW + 3600, updatedAt: NOW, ...overrides });

describe('diagnose', () => {
  it.each([
    ['no-data', state({ pct: null })],
    ['blind', state({ blind: true })],
    ['stale', state({ resetsAt: NOW - 1 })],
    ['disarmed', state({ pct: 95, disarmedUntil: NOW + 10 })],
    ['tripped', state({ pct: 95 })],
    ['armed', state({ pct: 40 })],
  ] as const)('reports %s', (expected, input) => {
    expect(diagnose(input, DEFAULT_CONFIG, 'session', NOW).status).toBe(expected);
  });

  it('reports what is left, and how much of it is reserved', () => {
    const detail = diagnose(state({ pct: 72 }), DEFAULT_CONFIG, 'session', NOW).detail;
    expect(detail).toContain('28% left');
    expect(detail).toContain('10% is reserved');
  });

  it('reports a reading whose window has reset, not merely an old one', () => {
    expect(diagnose(state({ resetsAt: NOW - 1 }), DEFAULT_CONFIG, 'session', NOW).detail).toContain('already reset');
    // An old reading inside a live window is still the truth.
    expect(diagnose(state({ updatedAt: NOW - 7200 }), DEFAULT_CONFIG, 'session', NOW).status).toBe('armed');
  });

  it('agrees with the boundary used by the gate', () => {
    expect(diagnose(state({ pct: 89 }), DEFAULT_CONFIG, 'session', NOW).status).toBe('armed');
    expect(diagnose(state({ pct: 90 }), DEFAULT_CONFIG, 'session', NOW).status).toBe('tripped');
  });
});

describe('diagnose — per limit', () => {
  const weekly = state({ weekly: { pct: 93, resetsAt: NOW + 86400 * 3, updatedAt: NOW } });

  it('reads each limit on its own', () => {
    expect(diagnose(weekly, DEFAULT_CONFIG, 'session', NOW).status).toBe('armed');
    expect(diagnose(weekly, DEFAULT_CONFIG, 'weekly', NOW).status).toBe('tripped');
  });

  it('reports no data for a limit the plan does not report', () => {
    expect(diagnose(state(), DEFAULT_CONFIG, 'weekly', NOW).status).toBe('no-data');
  });

  it('uses each limit its own reserve', () => {
    const config = { ...DEFAULT_CONFIG, reserve: { session: 10, weekly: 5 } };
    expect(diagnose(weekly, config, 'weekly', NOW).status).toBe('armed');
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45, '45s'],
    [90, '1m'],
    [3600, '1h 0m'],
    [10560, '2h 56m'],
    [3 * 86400 + 5 * 3600 + 60, '3d 5h'],
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
