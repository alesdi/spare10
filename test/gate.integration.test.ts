import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, readStopped } from '../src/state';
import { DEFAULT_STATE, type RunConfig, type State } from '../src/types';

const BUNDLE = join(__dirname, '..', 'dist', 'spare10.js');
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A stand-in for the `claude` CLI, first on PATH.
 *
 * The gate reaches background sessions through the CLI, and no test may depend on which sessions
 * happen to be running on the machine it is running on — nor start or stop any of them.
 */
function makeStub(listing: unknown[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'spare10-cli-'));
  writeFileSync(join(dir, 'listing.json'), JSON.stringify(listing));
  writeFileSync(
    join(dir, 'claude'),
    ['#!/bin/sh', `echo "$@" >> "${dir}/calls.log"`, `[ "$1" = agents ] && cat "${dir}/listing.json"`, 'exit 0', ''].join('\n'),
    { mode: 0o755 },
  );
  return dir;
}

/** Every `claude` invocation the stub saw, one argument line each. */
function calls(stub: string): string[] {
  try {
    return readFileSync(join(stub, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const stubbedPath = (stub: string) => ({
  ...process.env,
  PATH: `${stub}:${process.env['PATH'] ?? ''}`,
});

beforeAll(() => {
  execFileSync('node', [join(__dirname, '..', 'scripts', 'build.mjs')], { stdio: 'pipe' });
}, 30_000);

function makeRun(state: Partial<State>, config: Partial<RunConfig> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'spare10-gate-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ reserve: 10, pausePrompt: null, refresh: 5, badge: true, chain: null, ...config }),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ ...DEFAULT_STATE, updatedAt: nowSeconds(), resetsAt: nowSeconds() + 3600, ...state }),
  );
  return dir;
}

function invoke(command: 'gate', dir: string, payload: unknown, stub: string = makeStub()) {
  const result = spawnSync('node', [BUNDLE, command, '--run', dir], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: stubbedPath(stub),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    get json() {
      return result.stdout ? (JSON.parse(result.stdout) as Record<string, any>) : null;
    },
  };
}

const hookPayload = () => ({
  session_id: 'test-session',
  hook_event_name: 'PreToolUse',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});

/**
 * A stand-in for the Claude Code process: writes its own pid where the launcher would, runs
 * the gate as a child the way Claude Code runs hooks, and reports what the gate said — unless
 * the gate stopped it first, in which case it says nothing and exits on the signal.
 */
const STAND_IN = `
  const { spawnSync } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  const [bundle, dir, payload] = process.argv.slice(1);
  writeFileSync(dir + '/claude.pid', String(process.pid));
  const gate = spawnSync(process.execPath, [bundle, 'gate', '--run', dir], { input: payload, encoding: 'utf8' });
  process.stdout.write(gate.stdout);
`;

function invokeUnderStandIn(dir: string, payload: unknown, stub: string = makeStub()) {
  return spawnSync(process.execPath, ['-e', STAND_IN, BUNDLE, dir, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: stubbedPath(stub),
  });
}

describe('gate', () => {
  it('stays silent and exits zero when armed but below threshold', () => {
    const dir = makeRun({ pct: 40 });
    const result = invoke('gate', dir, hookPayload());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readState(dir).halted).toBeNull();
  });

  it('stops the Claude Code process it runs under, recording the session to resume', () => {
    const dir = makeRun({ pct: 93 });
    const standIn = invokeUnderStandIn(dir, hookPayload());
    expect(standIn.signal).toBe('SIGTERM');
    expect(standIn.stdout).toBe('');
    expect(readState(dir).halted).toBe('test-session');
  });

  it('falls back to denying the call when there is no process to stop', () => {
    // No pid file: the launcher decided the session could not be resumed.
    const dir = makeRun({ pct: 93 });
    const result = invoke('gate', dir, hookPayload());
    expect(result.status).toBe(0);
    expect(result.json?.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
    });
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toContain('7% of quota left');
    expect(readState(dir).halted).toBeNull();
  });

  it('never signals a process it is not running under', () => {
    const dir = makeRun({ pct: 93 });
    const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      writeFileSync(join(dir, 'claude.pid'), String(bystander.pid));
      const result = invoke('gate', dir, hookPayload());
      expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(bystander.exitCode).toBeNull();
      expect(bystander.signalCode).toBeNull();
      expect(readState(dir).halted).toBeNull();
    } finally {
      bystander.kill();
    }
  });

  it('cannot stop anything without a session id to resume', () => {
    const dir = makeRun({ pct: 93 });
    const { session_id: _dropped, ...anonymous } = hookPayload();
    const standIn = invokeUnderStandIn(dir, anonymous);
    expect(standIn.signal).toBeNull();
    expect(JSON.parse(standIn.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(existsSync(join(dir, 'claude.pid'))).toBe(true);
  });

  it('stops a background session through the CLI, having no process of its own to signal', () => {
    // A background session runs under Claude Code's daemon, so the launcher's pid — when there
    // is one at all — is never on this hook's parent chain. `claude stop` is the only handle.
    const dir = makeRun({ pct: 93 });
    const stub = makeStub([
      { id: 'be4ca65c', kind: 'background', sessionId: 'test-session', name: 'nightly', cwd: '/tmp/project' },
    ]);

    const result = invoke('gate', dir, hookPayload(), stub);

    expect(calls(stub)).toContain('stop be4ca65c');
    // The denial still goes out: the session may not be gone by the time the hook has to answer.
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readStopped(dir)).toMatchObject([
      { sessionId: 'test-session', backgroundId: 'be4ca65c', name: 'nightly', cwd: '/tmp/project' },
    ]);
  });

  it('leaves an interactive session it did not launch alone', () => {
    // Listed without a short id, so `claude stop` could not take it anyway — but the point is
    // that someone else's terminal is not spare10's to close.
    const dir = makeRun({ pct: 93 });
    const stub = makeStub([
      { pid: 4242, kind: 'interactive', sessionId: 'test-session', name: 'other-terminal', cwd: '/tmp/elsewhere' },
    ]);

    const result = invoke('gate', dir, hookPayload(), stub);

    expect(calls(stub).some((call) => call.startsWith('stop'))).toBe(false);
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readStopped(dir)).toEqual([]);
  });

  it('asks the CLI nothing when it has a process of its own to signal', () => {
    const dir = makeRun({ pct: 93 });
    const stub = makeStub();
    invokeUnderStandIn(dir, hookPayload(), stub);
    expect(calls(stub)).toEqual([]);
  });

  it('injects the pause prompt without blocking, then lets that agent through to comply', () => {
    const dir = makeRun({ pct: 93 }, { pausePrompt: 'Finish this block, commit and stop.' });
    const result = invoke('gate', dir, hookPayload());
    const output = result.json?.hookSpecificOutput;

    expect(output.additionalContext).toContain('Finish this block, commit and stop.');
    expect(output.permissionDecision).toBeUndefined();

    const state = readState(dir);
    expect(state.pausePromptInjectedTo).toEqual(['test-session:main']);
    expect(state.disarmedUntil).toBeNull();

    expect(invoke('gate', dir, hookPayload()).stdout).toBe('');
  });

  it('injects the pause prompt into every subagent, not just the first caller', () => {
    const dir = makeRun({ pct: 93 }, { pausePrompt: 'Commit and stop.' });
    const sub = (id: string) => ({ ...hookPayload(), agent_id: id, agent_type: 'Explore' });

    invoke('gate', dir, hookPayload());
    expect(invoke('gate', dir, sub('a')).json?.hookSpecificOutput.additionalContext).toContain('Commit and stop.');
    expect(invoke('gate', dir, sub('b')).json?.hookSpecificOutput.additionalContext).toContain('Commit and stop.');

    // Each agent is told once; afterwards its own calls pass while newcomers are still told.
    expect(invoke('gate', dir, sub('a')).stdout).toBe('');
    expect(invoke('gate', dir, hookPayload()).stdout).toBe('');
    expect(readState(dir).pausePromptInjectedTo).toEqual([
      'test-session:main',
      'test-session:a',
      'test-session:b',
    ]);
  });

  it('injects the pause prompt into every session sharing the run, not just the first', () => {
    // One run directory serves every background session dispatched under its settings, and each
    // of their main threads reports no agent id at all.
    const dir = makeRun({ pct: 93 }, { pausePrompt: 'Commit and stop.' });
    const session = (id: string) => ({ ...hookPayload(), session_id: id });

    expect(invoke('gate', dir, session('one')).json?.hookSpecificOutput.additionalContext).toContain('Commit and stop.');
    expect(invoke('gate', dir, session('two')).json?.hookSpecificOutput.additionalContext).toContain('Commit and stop.');
    expect(invoke('gate', dir, session('one')).stdout).toBe('');

    expect(readState(dir).pausePromptInjectedTo).toEqual(['one:main', 'two:main']);
  });

  it('survives an unparseable payload without blocking', () => {
    const dir = makeRun({ pct: 93 });
    const result = invoke('gate', dir, 'not json at all');
    expect(result.status).toBe(0);
    // No session to resume, so it falls back to denying rather than failing.
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('drains a large payload without erroring', () => {
    const dir = makeRun({ pct: 40 });
    const huge = { ...hookPayload(), tool_input: { content: 'x'.repeat(2_000_000) } };
    const result = invoke('gate', dir, huge);
    expect(result.status).toBe(0);
  });

  it('fails open when the run directory is missing entirely', () => {
    const result = invoke('gate', join(tmpdir(), 'spare10-does-not-exist'), hookPayload());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('after a resume', () => {
  it('passes for the rest of the window once the launcher has disarmed the run', () => {
    // What the launcher writes when the user answers yes to "Resume anyway?".
    const dir = makeRun({ pct: 93, disarmedUntil: nowSeconds() + 3600 });
    const standIn = invokeUnderStandIn(dir, hookPayload());
    expect(standIn.signal).toBeNull();
    expect(standIn.stdout).toBe('');
  });
});

