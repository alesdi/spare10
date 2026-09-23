import { describe, expect, it } from 'vitest';
import { detectCaps, keyToAction, splitKeys } from '../src/terminal';

describe('keyToAction', () => {
  it.each([
    ['\u001b[D', 'prev'],
    ['\u001b[A', 'prev'],
    ['\u001bOD', 'prev'],
    ['\u001b[C', 'next'],
    ['\u001b[B', 'next'],
    ['\t', 'next'],
    ['\r', 'confirm'],
    ['\n', 'confirm'],
    ['y', 'yes'],
    ['Y', 'yes'],
    ['n', 'no'],
    ['q', 'no'],
    ['\u001b', 'cancel'],
    ['\u0003', 'cancel'],
    ['\u0004', 'cancel'],
    ['h', 'prev'],
    ['l', 'next'],
  ])('reads %j as %s', (bytes, action) => {
    expect(keyToAction(bytes)).toBe(action);
  });

  it('ignores keys that mean nothing here', () => {
    for (const key of ['a', ' ', '1', '\u001b[5~']) expect(keyToAction(key)).toBeNull();
  });

  it('tells a bare escape from an arrow key, which starts with the same byte', () => {
    expect(keyToAction('\u001b')).toBe('cancel');
    expect(keyToAction('\u001b[C')).toBe('next');
  });
});

describe('detectCaps', () => {
  const base = { TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };

  it('takes colour and unicode from a normal terminal', () => {
    expect(detectCaps(base, 100)).toEqual({ color: true, truecolor: false, unicode: true, columns: 100 });
  });

  it('honours NO_COLOR', () => {
    expect(detectCaps({ ...base, NO_COLOR: '1' }, 100).color).toBe(false);
  });

  it('gives a dumb terminal neither colour nor box drawing', () => {
    const caps = detectCaps({ TERM: 'dumb' }, 100);
    expect(caps.color).toBe(false);
    expect(caps.unicode).toBe(false);
  });

  it('uses 24-bit colour only when the terminal advertises it', () => {
    expect(detectCaps({ ...base, COLORTERM: 'truecolor' }, 100).truecolor).toBe(true);
    expect(detectCaps({ ...base, COLORTERM: '256' }, 100).truecolor).toBe(false);
  });

  it('keeps block characters away from a terminal in a non-UTF-8 locale', () => {
    expect(detectCaps({ ...base, LANG: 'C' }, 100).unicode).toBe(false);
    expect(detectCaps({ TERM: 'xterm' }, 100).unicode).toBe(true); // unset locale: still UTF-8 in practice
  });
});

describe('splitKeys', () => {
  it('keeps an escape sequence whole', () => {
    expect(splitKeys('\u001b[C')).toEqual(['\u001b[C']);
    expect(splitKeys('\u001bOA')).toEqual(['\u001bOA']);
  });

  it('separates keys that arrived in one read, as a paste or fast typing delivers them', () => {
    expect(splitKeys('\u001b[D\r')).toEqual(['\u001b[D', '\r']);
    expect(splitKeys('yn')).toEqual(['y', 'n']);
    expect(splitKeys('\u001b[C\u001b[C\r')).toEqual(['\u001b[C', '\u001b[C', '\r']);
  });

  it('treats a trailing escape as the Escape key, since nothing follows it', () => {
    expect(splitKeys('\u001b')).toEqual(['\u001b']);
    expect(splitKeys('a\u001b')).toEqual(['a', '\u001b']);
  });

  it('does not choke on an unterminated sequence', () => {
    expect(splitKeys('\u001b[')).toEqual(['\u001b[']);
  });

  it('is empty for an empty read', () => {
    expect(splitKeys('')).toEqual([]);
  });
});
