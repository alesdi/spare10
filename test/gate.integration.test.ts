import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../src/state';
import { DEFAULT_STATE, type RunConfig, type State } from '../src/types';

const BUNDLE = join(__dirname, '..', 'dist', 'spare10.js');
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeAll(() => {
  execFileSync('node', [join(__dirname, '..', 'scripts', 'build.mjs')], { stdio: 'pipe' });
}, 30_000);

function makeRun(state: Partial<State>, config: Partial<RunConfig> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'spare10-gate-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ threshold: 90, pausePrompt: null, refresh: 5, badge: true, chain: null, ...config }),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({ ...DEFAULT_STATE, updatedAt: nowSeconds(), resetsAt: nowSeconds() + 3600, ...state }),
  );
  return dir;
}

function invoke(command: 'gate' | 'post', dir: string, payload: unknown) {
  const result = spawnSync('node', [BUNDLE, command, '--run', dir], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    json: result.stdout ? (JSON.parse(result.stdout) as Record<string, any>) : null,
  };
}

const hookPayload = (permissionMode = 'default') => ({
  session_id: 'test',
  hook_event_name: 'PreToolUse',
  permission_mode: permissionMode,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});

describe('gate', () => {
  it('stays silent and exits zero when armed but below threshold', () => {
    const dir = makeRun({ pct: 40 });
    const result = invoke('gate', dir, hookPayload());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readState(dir).awaitingApproval).toBe(false);
  });

  it('emits an ask decision and records that it is awaiting approval', () => {
    const dir = makeRun({ pct: 93 });
    const result = invoke('gate', dir, hookPayload());
    expect(result.status).toBe(0);
    expect(result.json?.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
    });
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toContain('93%');
    expect(readState(dir).awaitingApproval).toBe(true);
  });

  it('denies rather than asking when the mode would auto-approve the dialog', () => {
    const dir = makeRun({ pct: 93 });
    const result = invoke('gate', dir, hookPayload('bypassPermissions'));
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
    // Nothing to approve, so nothing to wait for.
    expect(readState(dir).awaitingApproval).toBe(false);
  });

  it('injects the pause prompt without blocking, then disarms so the agent can comply', () => {
    const dir = makeRun({ pct: 93 }, { pausePrompt: 'Finish this block, commit and stop.' });
    const result = invoke('gate', dir, hookPayload());
    const output = result.json?.hookSpecificOutput;

    expect(output.additionalContext).toContain('Finish this block, commit and stop.');
    expect(output.permissionDecision).toBeUndefined();

    const state = readState(dir);
    expect(state.pausePromptInjected).toBe(true);
    expect(state.disarmedUntil).toBe(state.resetsAt);
  });

  it('survives an unparseable payload without blocking', () => {
    const dir = makeRun({ pct: 93 });
    const result = invoke('gate', dir, 'not json at all');
    expect(result.status).toBe(0);
    // No permission_mode to read, so it falls back to asking rather than failing.
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('ask');
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

describe('the ask → approve → disarm cycle', () => {
  it('disarms for the rest of the window once the tool actually runs', () => {
    const dir = makeRun({ pct: 93 });

    invoke('gate', dir, hookPayload());
    expect(readState(dir).awaitingApproval).toBe(true);

    // The user approved, so Claude Code ran the tool and PostToolUse fires.
    invoke('post', dir, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    const state = readState(dir);
    expect(state.awaitingApproval).toBe(false);
    expect(state.disarmedUntil).toBe(state.resetsAt);

    // The next tool call sails through instead of nagging.
    expect(invoke('gate', dir, hookPayload()).stdout).toBe('');
  });

  it('keeps asking when the user pressed Esc, because PostToolUse never fired', () => {
    const dir = makeRun({ pct: 93 });
    invoke('gate', dir, hookPayload());
    const second = invoke('gate', dir, hookPayload());
    expect(second.json?.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(readState(dir).disarmedUntil).toBeNull();
  });

  it('does not disarm on unrelated tool calls', () => {
    const dir = makeRun({ pct: 40 });
    invoke('post', dir, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
    expect(readState(dir).disarmedUntil).toBeNull();
  });
});
