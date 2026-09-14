import { describe, expect, it } from 'vitest';
import { pickSeed } from '../src/state';
import { DEFAULT_STATE, type State } from '../src/types';

const NOW = 1_000_000;
const reading = (overrides: Partial<State>): State => ({ ...DEFAULT_STATE, ...overrides });

describe('pickSeed', () => {
  it('opens a new run with the newest reading from the same window', () => {
    const seed = pickSeed(
      [
        reading({ pct: 40, resetsAt: NOW + 100, updatedAt: NOW - 900 }),
        reading({ pct: 95, resetsAt: NOW + 100, updatedAt: NOW - 10 }),
      ],
      NOW,
    );
    expect(seed).toMatchObject({ pct: 95, resetsAt: NOW + 100, updatedAt: NOW - 10 });
  });

  it('ignores readings from a window that has already reset', () => {
    expect(pickSeed([reading({ pct: 99, resetsAt: NOW - 1, updatedAt: NOW - 5 })], NOW)).toBeNull();
  });

  it('ignores runs that never produced a reading', () => {
    expect(pickSeed([reading({ pct: null, resetsAt: NOW + 100 })], NOW)).toBeNull();
  });

  it('returns nothing when there are no previous runs at all', () => {
    expect(pickSeed([], NOW)).toBeNull();
  });

  it('carries the quota over but never the consent', () => {
    const seed = pickSeed(
      [
        reading({
          pct: 95,
          resetsAt: NOW + 100,
          updatedAt: NOW - 10,
          disarmedUntil: NOW + 100,
          pausePromptInjectedTo: ['main'],
          halted: 'abc',
        }),
      ],
      NOW,
    );
    expect(seed).toMatchObject({
      disarmedUntil: null,
      pausePromptInjectedTo: [],
      halted: null,
    });
  });
});
