import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../src/args';
import { buildSettings, readChainTarget, shellQuote } from '../src/settings';

describe('parseArgs', () => {
  it('defaults to a 90% threshold and no pause prompt', () => {
    const { config, command } = parseArgs(['claude']);
    expect(config).toMatchObject({ threshold: 90, pausePrompt: null, refresh: 5, badge: true });
    expect(command).toEqual(['claude']);
  });

  it('passes everything after the command through untouched', () => {
    const { command } = parseArgs(['--threshold', '85', 'claude', '--resume', '-p', 'hi']);
    expect(command).toEqual(['claude', '--resume', '-p', 'hi']);
  });

  it('does not consume flags that belong to the wrapped command', () => {
    const { config, command } = parseArgs(['claude', '--threshold', '10']);
    expect(config.threshold).toBe(90);
    expect(command).toEqual(['claude', '--threshold', '10']);
  });

  it('keeps a multi-line pause prompt intact', () => {
    const prompt = 'Finish this block.\nCommit, then stop.';
    expect(parseArgs(['--pause-prompt', prompt, 'claude']).config.pausePrompt).toBe(prompt);
  });

  it('rejects a fractional threshold rather than silently flooring it', () => {
    // used_percentage is an integer, so 90.5 could never be observed.
    expect(() => parseArgs(['--threshold', '90.5', 'claude'])).toThrow(/whole number/);
  });

  it.each([['0'], ['100'], ['-5']])('rejects an out-of-range threshold: %s', (value) => {
    expect(() => parseArgs(['--threshold', value, 'claude'])).toThrow(UsageError);
  });

  it.each([['--threshold'], ['--pause-prompt'], ['--refresh']])(
    'rejects %s with no value',
    (flag) => {
      expect(() => parseArgs([flag])).toThrow(/requires a value/);
    },
  );

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['--nope', 'claude'])).toThrow(/Unknown option/);
  });

  it('rejects an empty invocation', () => {
    expect(() => parseArgs([])).toThrow(/No command given/);
  });
});

describe('readChainTarget', () => {
  const withSettings = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'spare10-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, contents);
    return path;
  };

  it('finds the status line it is about to replace, and keeps its padding', () => {
    const path = withSettings(
      JSON.stringify({ statusLine: { type: 'command', command: 'my-statusline', padding: 0 } }),
    );
    expect(readChainTarget(path)).toEqual({ command: 'my-statusline', padding: 0 });
  });

  it('refuses to chain into another spare10, which would recurse every refresh', () => {
    const path = withSettings(JSON.stringify({ statusLine: { command: '/x/spare10 sensor' } }));
    expect(readChainTarget(path).command).toBeNull();
  });

  it.each([
    ['no statusLine configured', '{}'],
    ['malformed json', '{ not json'],
    ['a null root', 'null'],
  ])('returns no target when there is %s', (_label, contents) => {
    expect(readChainTarget(withSettings(contents)).command).toBeNull();
  });

  it('returns no target when the file does not exist', () => {
    expect(readChainTarget('/nonexistent/settings.json').command).toBeNull();
  });
});

describe('buildSettings', () => {
  const settings = buildSettings({
    nodePath: '/usr/local/bin/node',
    selfPath: "/home/o'brien/spare10/dist/spare10.js",
    runDir: '/run dir/abc',
    refresh: 5,
    padding: 0,
  });

  it('registers both hooks so the approval signal can be observed', () => {
    expect(Object.keys(settings['hooks'] as object)).toEqual(['PreToolUse', 'PostToolUse']);
  });

  it('invokes spare10 by absolute path, never through a package runner', () => {
    const command = (settings['statusLine'] as Record<string, string>)['command'] as string;
    expect(command).toContain('/usr/local/bin/node');
    expect(command).not.toContain('npx');
    expect(command).toContain('sensor --run');
  });

  it('quotes paths containing spaces and apostrophes', () => {
    const command = (settings['statusLine'] as Record<string, string>)['command'] as string;
    expect(command).toContain(`'/run dir/abc'`);
    expect(command).toContain(`'/home/o'\\''brien/spare10/dist/spare10.js'`);
  });

  it('preserves the padding from the user configuration it is replacing', () => {
    expect((settings['statusLine'] as Record<string, unknown>)['padding']).toBe(0);
    const noPadding = buildSettings({
      nodePath: 'node', selfPath: 's', runDir: 'r', refresh: 5, padding: undefined,
    });
    expect((noPadding['statusLine'] as Record<string, unknown>)['padding']).toBeUndefined();
  });

  it('serialises to valid JSON for --settings', () => {
    expect(() => JSON.parse(JSON.stringify(settings))).not.toThrow();
  });
});

describe('shellQuote', () => {
  it.each([
    ['plain', 'plain', `'plain'`],
    ['with space', 'a b', `'a b'`],
    ['with apostrophe', "o'brien", `'o'\\''brien'`],
  ])('quotes %s', (_label, input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });
});
