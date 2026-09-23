import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../src/args';
import {
  backgrounded,
  haltVerdict,
  pinSelf,
  preflightVerdict,
  RESUME_PROMPT,
  resumable,
  resumeArgs,
  stoppedView,
  subcommandOf,
} from '../src/launch';
import type { StoppedSession } from '../src/types';
import { buildSettings, readChainTarget, shellQuote } from '../src/settings';

describe('parseArgs', () => {
  it('defaults to a 10% reserve and no pause prompt', () => {
    const { config, command } = parseArgs(['claude']);
    expect(config).toMatchObject({ reserve: 10, pausePrompt: null, refresh: 2, badge: true });
    expect(command).toEqual(['claude']);
  });

  it('passes everything after the command through untouched', () => {
    const { command } = parseArgs(['--reserve', '15', 'claude', '--resume', '-p', 'hi']);
    expect(command).toEqual(['claude', '--resume', '-p', 'hi']);
  });

  it('does not consume flags that belong to the wrapped command', () => {
    const { config, command } = parseArgs(['claude', '--reserve', '40']);
    expect(config.reserve).toBe(10);
    expect(command).toEqual(['claude', '--reserve', '40']);
  });

  it('keeps a multi-line pause prompt intact', () => {
    const prompt = 'Finish this block.\nCommit, then stop.';
    expect(parseArgs(['--pause-prompt', prompt, 'claude']).config.pausePrompt).toBe(prompt);
  });

  it('rejects a fractional reserve rather than silently flooring it', () => {
    // used_percentage is an integer, so 10.5 could never be observed.
    expect(() => parseArgs(['--reserve', '10.5', 'claude'])).toThrow(/whole number/);
  });

  it.each([['0'], ['100'], ['-5']])('rejects an out-of-range reserve: %s', (value) => {
    expect(() => parseArgs(['--reserve', value, 'claude'])).toThrow(UsageError);
  });

  it('points the old --threshold flag at its replacement', () => {
    expect(() => parseArgs(['--threshold', '90', 'claude'])).toThrow(/--reserve 10/);
  });

  it.each([['--reserve'], ['--pause-prompt'], ['--refresh']])(
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

describe('pinSelf', () => {
  it('copies the bundle into the run directory so an upgrade cannot change a live session', () => {
    // The hook commands are frozen into --settings at launch; the installed bundle is not.
    const runDir = mkdtempSync(join(tmpdir(), 'spare10-pin-'));
    const install = join(mkdtempSync(join(tmpdir(), 'spare10-install-')), 'spare10.js');
    writeFileSync(install, '// version under test');

    const pinned = pinSelf(runDir, install);
    expect(pinned).toBe(join(runDir, 'spare10.js'));
    expect(readFileSync(pinned, 'utf8')).toBe('// version under test');

    writeFileSync(install, '// upgraded');
    expect(readFileSync(pinned, 'utf8')).toBe('// version under test');
  });

  it('falls back to the installed bundle when the copy cannot be made', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'spare10-pin-'));
    expect(pinSelf(runDir, '/nonexistent/spare10.js')).toBe('/nonexistent/spare10.js');
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

  it('registers the gate alone, and nothing on prompt submit', () => {
    // UserPromptSubmit has no user-visible non-blocking channel: stdout there is model
    // context, which the model paraphrases, and exit 2 erases what the user typed.
    expect(Object.keys(settings['hooks'] as object)).toEqual(['PreToolUse']);
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

describe('preflightVerdict', () => {
  it('says nothing when the reserve is untouched', () => {
    expect(preflightVerdict(false, null)).toBe('clear');
  });

  it.each([['y'], ['Y'], ['yes'], ['  yes  ']])('treats %s as consent', (answer) => {
    expect(preflightVerdict(true, answer)).toBe('consented');
  });

  it.each([[''], ['n'], ['no'], ['anything else']])('treats %s as a refusal', (answer) => {
    // Empty means a bare Enter, which must not start a session that is already spent.
    expect(preflightVerdict(true, answer)).toBe('declined');
  });

  it('starts when there is no terminal to ask', () => {
    expect(preflightVerdict(true, null)).toBe('proceeding');
  });
});

describe('haltVerdict', () => {
  it.each([['y'], ['Yes']])('resumes on %s', (answer) => {
    expect(haltVerdict(answer)).toBe('resume');
  });

  it.each([[''], ['n'], ['later']])('leaves the session stopped on %s', (answer) => {
    expect(haltVerdict(answer)).toBe('declined');
  });

  it('knows when nobody was there to ask', () => {
    expect(haltVerdict(null)).toBe('unattended');
  });
});

describe('subcommandOf', () => {
  it.each([
    ['the agent view', ['agents'], 'agents'],
    ['a subcommand behind flags', ['--reserve-nothing', 'agents'], 'agents'],
    ['the agent view with its own options', ['agents', '--model', 'opus'], 'agents'],
    ['an ordinary session', [], null],
    ['a session with a prompt', ['-p', 'fix the build'], null],
    ['a session whose prompt is not a subcommand', ['write an agents page'], null],
  ])('reads %s', (_label, args, expected) => {
    expect(subcommandOf(args)).toBe(expected);
  });

  it('does not mistake a flag value for a subcommand', () => {
    // `--model agents` is a model named agents, not the agent view.
    expect(subcommandOf(['--model', 'agents'])).toBeNull();
    expect(subcommandOf(['--add-dir', 'one', 'agents'])).toBeNull();
  });

  it('stops at the positional separator', () => {
    expect(subcommandOf(['--', 'agents'])).toBeNull();
  });
});

describe('backgrounded', () => {
  it.each([[['--bg']], [['--background']], [['--resume', 'abc', '--bg']]])(
    'spots %s',
    (args) => {
      expect(backgrounded(args)).toBe(true);
    },
  );

  it('is false for an ordinary session', () => {
    expect(backgrounded(['--model', 'opus'])).toBe(false);
  });
});

describe('stoppedView', () => {
  const record = (overrides: Partial<StoppedSession> = {}): StoppedSession => ({
    sessionId: 'f7f9f966-d793-4063-acf3-2e064b89e997',
    backgroundId: 'f7f9f966',
    name: 'nightly refactor',
    cwd: '/home/example/project',
    at: 1_000_000,
    ...overrides,
  });

  it('names one paused session in the singular', () => {
    const view = stoppedView([record()], '/home/example');
    expect(view.headline).toBe('Reserve reached. A background session is paused.');
    expect(view.choices[0].label).toBe('Resume');
    expect(view.body).toContain('nightly refactor · ~/project');
  });

  it('counts them when there are several', () => {
    const view = stoppedView([record(), record({ sessionId: 'b', backgroundId: 'b' })], '/home/example');
    expect(view.headline).toBe('Reserve reached. 2 background sessions are paused.');
    expect(view.choices[0].label).toBe('Resume all');
  });

  it('lists at most five, then counts the rest', () => {
    // A fleet can be large, and a panel that grows past the terminal is no longer a panel.
    const many = Array.from({ length: 8 }, (_unused, i) =>
      record({ sessionId: `s${i}`, backgroundId: `s${i}`, name: `session ${i}` }),
    );
    const view = stoppedView(many, '/home/example');
    expect(view.body.filter((line) => line.startsWith('session '))).toHaveLength(5);
    expect(view.body).toContain('…and 3 more.');
  });

  it('falls back to the short id when a session never named itself', () => {
    const view = stoppedView([record({ name: null })], '/home/example');
    expect(view.body).toContain('f7f9f966 · ~/project');
  });

  it('offers exactly two answers, the safe one second', () => {
    const view = stoppedView([record()], '/home/example');
    expect(view.choices).toHaveLength(2);
    expect(view.choices[1].label).toBe('Leave stopped');
  });
});

describe('resumable', () => {
  it('is the default', () => {
    expect(resumable(['--model', 'opus'], {})).toBe(true);
  });

  it('is off when the user asked for no persistence', () => {
    expect(resumable(['--no-session-persistence'], {})).toBe(false);
  });

  it('is off inside another Claude Code session, unless persistence is forced', () => {
    expect(resumable([], { CLAUDE_CODE_CHILD_SESSION: '1' })).toBe(false);
    expect(
      resumable([], { CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' }),
    ).toBe(true);
  });
});

describe('resumeArgs', () => {
  const resume = (args: string[]) => resumeArgs(args, 'sid');

  it('points at the stopped session and asks it to carry on', () => {
    expect(resume([])).toEqual(['--resume', 'sid', RESUME_PROMPT]);
  });

  it('keeps the flags the session was started with', () => {
    expect(resume(['--model', 'opus', '--dangerously-skip-permissions', '--effort=high'])).toEqual([
      '--resume', 'sid', '--model', 'opus', '--dangerously-skip-permissions', '--effort=high', RESUME_PROMPT,
    ]);
  });

  it('drops the original prompt, which was delivered the first time', () => {
    expect(resume(['Implement the parser', '--model', 'opus'])).toEqual([
      '--resume', 'sid', '--model', 'opus', RESUME_PROMPT,
    ]);
  });

  it('does not mistake a flag value for the prompt', () => {
    expect(resume(['--append-system-prompt', 'Be terse'])).toEqual([
      '--resume', 'sid', '--append-system-prompt', 'Be terse', RESUME_PROMPT,
    ]);
  });

  it('keeps every value of a variadic flag', () => {
    expect(resume(['--add-dir', '../a', '../b', '--model', 'opus'])).toEqual([
      '--resume', 'sid', '--add-dir', '../a', '../b', '--model', 'opus', RESUME_PROMPT,
    ]);
  });

  it('takes an optional value only when one is there', () => {
    expect(resume(['--debug', 'api', '--verbose'])).toEqual([
      '--resume', 'sid', '--debug', 'api', '--verbose', RESUME_PROMPT,
    ]);
    expect(resume(['--debug', '--verbose'])).toEqual(['--resume', 'sid', '--debug', '--verbose', RESUME_PROMPT]);
  });

  it.each([
    [['--continue']],
    [['-c']],
    [['--resume']],
    [['--resume', 'old-id']],
    [['-r', 'old-id']],
    [['--session-id', 'old-id']],
    [['--worktree', 'feature']],
    [['-w']],
    [['--tmux']],
  ])('replaces the way the session was chosen: %j', (args) => {
    expect(resume([...args, '--model', 'opus'])).toEqual(['--resume', 'sid', '--model', 'opus', RESUME_PROMPT]);
  });

  it('drops everything after a bare --, which is all positional', () => {
    expect(resume(['--model', 'opus', '--', 'do the thing'])).toEqual([
      '--resume', 'sid', '--model', 'opus', RESUME_PROMPT,
    ]);
  });
});
