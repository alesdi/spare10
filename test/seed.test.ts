import { describe, expect, it } from 'vitest';
import { pickSeed } from '../src/state';
import { EMPTY_LIMIT } from '../src/types';
import { stateWith as reading } from './helpers';

const NOW = 1_000_000;

describe('pickSeed', () => {
  it('opens a new run with the newest reading from the same window', () => {
    const seed = pickSeed(
      [
        reading({ pct: 40, resetsAt: NOW + 100, updatedAt: NOW - 900 }),
        reading({ pct: 95, resetsAt: NOW + 100, updatedAt: NOW - 10 }),
      ],
      NOW,
    );
    expect(seed?.limits.session).toMatchObject({ pct: 95, resetsAt: NOW + 100, updatedAt: NOW - 10 });
  });

  it('seeds each limit from its own newest reading', () => {
    const seed = pickSeed(
      [
        reading({ pct: 40, resetsAt: NOW + 100, updatedAt: NOW - 10 }),
        reading({
          pct: 30,
          resetsAt: NOW + 100,
          updatedAt: NOW - 900,
          weekly: { pct: 88, resetsAt: NOW + 86400, updatedAt: NOW - 900 },
        }),
      ],
      NOW,
    );
    expect(seed?.limits.session.pct).toBe(40);
    expect(seed?.limits.weekly).toMatchObject({ pct: 88, resetsAt: NOW + 86400 });
  });

  it('seeds the weekly limit even when the session window has reset', () => {
    const seed = pickSeed(
      [reading({ pct: 99, resetsAt: NOW - 1, updatedAt: NOW - 5, weekly: { pct: 70, resetsAt: NOW + 86400, updatedAt: NOW - 5 } })],
      NOW,
    );
    expect(seed?.limits.session).toEqual(EMPTY_LIMIT);
    expect(seed?.limits.weekly.pct).toBe(70);
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
    expect(seed?.halted).toBeNull();
    expect(seed?.limits.session).toMatchObject({ disarmedUntil: null, pausePromptInjectedTo: [] });
  });
});
