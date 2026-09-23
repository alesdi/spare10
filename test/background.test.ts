import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBackground, parseAgentsListing, resumeArgv, stillStopped } from '../src/background';

const LISTING = readFileSync(join(__dirname, 'fixtures', 'agents.json'), 'utf8');

describe('parseAgentsListing', () => {
  it('reads every session out of a real listing', () => {
    expect(parseAgentsListing(LISTING)).toEqual([
      {
        sessionId: 'be4ca65c-d8ea-4fce-a195-7fe4c2fd7d0d',
        backgroundId: 'be4ca65c',
        kind: 'background',
        name: 'Multiple agents for parallelization',
        cwd: '/Users/example/project',
      },
      {
        sessionId: 'f7f9f966-d793-4063-acf3-2e064b89e997',
        backgroundId: null,
        kind: 'interactive',
        name: 'other-9f',
        cwd: '/Users/example/other',
      },
      {
        sessionId: '206672f0-1f3c-4a52-8b21-9c0f4a5d6e70',
        backgroundId: '206672f0',
        kind: 'background',
        name: 'datacenter research',
        cwd: '/Users/example/project',
      },
    ]);
  });

  it('gives an interactive session no short id, because the listing gives it none', () => {
    // It is the one handle `claude stop` takes, and the reason an interactive session is
    // stopped by signalling its process instead.
    const interactive = parseAgentsListing(LISTING)[1];
    expect(interactive?.kind).toBe('interactive');
    expect(interactive?.backgroundId).toBeNull();
  });

  it.each([
    ['not json at all', 'not json at all'],
    ['a truncated listing', '[{"id": "be4ca65'],
    ['an object where an array belongs', '{"sessions": []}'],
    ['nothing', ''],
  ])('reads %s as no sessions rather than throwing', (_label, raw) => {
    // The schema is undocumented and free to change; a gate that throws here loses the tool
    // call it was asked about.
    expect(parseAgentsListing(raw)).toEqual([]);
  });

  it('skips entries with no session id, keeping the rest', () => {
    const raw = JSON.stringify([{ id: 'nameless' }, { sessionId: 'real', id: 'r', kind: 'background' }]);
    expect(parseAgentsListing(raw).map((entry) => entry.sessionId)).toEqual(['real']);
  });
});

describe('findBackground', () => {
  const entries = parseAgentsListing(LISTING);

  it('finds the background session behind a session id', () => {
    expect(findBackground(entries, '206672f0-1f3c-4a52-8b21-9c0f4a5d6e70')).toMatchObject({
      backgroundId: '206672f0',
      name: 'datacenter research',
    });
  });

  it('refuses an interactive session, which is not the CLI’s to stop', () => {
    expect(findBackground(entries, 'f7f9f966-d793-4063-acf3-2e064b89e997')).toBeNull();
  });

  it('refuses a session the listing does not know', () => {
    expect(findBackground(entries, 'never-started')).toBeNull();
  });

  it('refuses a background session listed without a short id', () => {
    // Nothing to hand `claude stop`, so there is nothing to do but deny the call.
    const odd = parseAgentsListing(JSON.stringify([{ sessionId: 'x', kind: 'background' }]));
    expect(findBackground(odd, 'x')).toBeNull();
  });
});

describe('resumeArgv', () => {
  it('resumes the session itself, carrying no flags at all', () => {
    // A background session keeps the options it was started with, so it comes back already
    // carrying spare10's sensor and gate. Any flag here — `--settings` included — makes Claude
    // Code start a *copy* under a new id instead of continuing this one.
    expect(resumeArgv('725e41b6-f6f4-48b8-9250-89a0ed2a26b1')).toEqual([
      '--bg',
      '--resume',
      '725e41b6-f6f4-48b8-9250-89a0ed2a26b1',
    ]);
  });
});

describe('stillStopped', () => {
  const records = [{ sessionId: 'a' }, { sessionId: 'b' }];

  it('drops a session that is running again', () => {
    // Picked up by hand with `claude attach`. Resuming it would start a copy of a session that
    // never stopped, under a new id.
    const active = parseAgentsListing(JSON.stringify([{ sessionId: 'a', id: 'a1', kind: 'background' }]));
    expect(stillStopped(records, active)).toEqual([{ sessionId: 'b' }]);
  });

  it('keeps everything when nothing is running', () => {
    expect(stillStopped(records, [])).toEqual(records);
  });

  it('keeps everything when the listing could not be read', () => {
    // An empty listing is also what a missing or failing CLI looks like: report rather than
    // quietly forget, as everywhere else here.
    expect(stillStopped(records, parseAgentsListing('not json'))).toEqual(records);
  });
});
