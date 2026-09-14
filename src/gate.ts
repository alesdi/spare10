import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { decide } from './decide';
import { parseHookPayload } from './hook-payload';
import { nowSeconds, pidPath, readRunConfig, readState, writeState } from './state';
import { agentKey, type State } from './types';

/**
 * Consume stdin without parsing it. Claude Code writes the full hook payload — which can be
 * large, e.g. a Write tool's entire file content — and exiting without reading it risks EPIPE
 * on the writer.
 */
function drainStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(hookSpecificOutput: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

/**
 * How long to give Claude Code to act on SIGTERM. It reaps this hook on the way out, so in the
 * normal case the wait never ends — which keeps the fallback denial out of the transcript.
 */
const KILL_GRACE_MS = 2000;

function readClaudePid(runDir: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath(runDir), 'utf8').trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function parentOf(pid: number): number | null {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' });
  const parent = Number(result.stdout.trim());
  return result.status === 0 && Number.isInteger(parent) && parent > 0 ? parent : null;
}

/**
 * Only ever signal a process this hook is running under. The pid file names the launcher's
 * child, but pids get recycled, and a hook that SIGTERMs the wrong process is far worse than
 * one that falls back to a denial.
 */
export function isAncestor(pid: number, from: number = process.ppid): boolean {
  let current: number | null = from;
  for (let hops = 0; current !== null && current > 1 && hops < 32; hops += 1) {
    if (current === pid) return true;
    current = parentOf(current);
  }
  return false;
}

function block(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop Claude Code outright. The launcher sees the SIGTERM exit, reads `halted` from state,
 * and asks the user in the terminal whether to resume the session — spare10's own prompt,
 * in every permission mode, with subagents and background tasks gone along with the process.
 *
 * Denial is the fallback, not the plan: it is the strongest thing a hook can do on its own,
 * but the model can keep trying other tools against it.
 */
function halt(runDir: string, state: State, sessionId: string | null, reason: string): number {
  const pid = sessionId === null ? null : readClaudePid(runDir);

  if (pid !== null && isAncestor(pid)) {
    // State first: nothing after a successful kill is guaranteed to run. `halted` is left set
    // even if the signal is slow to take — the launcher only acts on it after a SIGTERM exit.
    writeState(runDir, { ...state, halted: sessionId });
    try {
      process.kill(pid, 'SIGTERM');
      block(KILL_GRACE_MS);
    } catch {
      /* fall through to the denial */
    }
  }

  // Still here: no process to stop, or one that did not go. Claude Code is waiting on this
  // hook either way, and a denial keeps the tool call from running.

  emit({
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  });
  return 0;
}

export function runGate(runDir: string): number {
  const config = readRunConfig(runDir);
  const state = readState(runDir);
  const now = nowSeconds();

  // Hot path. On the overwhelming majority of tool calls the answer is "pass", and reaching it
  // costs one small file read — the payload is never parsed.
  if (decide({ state, config, now, agent: null }).kind === 'pass') {
    drainStdin();
    return 0;
  }

  const { sessionId, agentId } = parseHookPayload(drainStdin());
  const agent = agentKey(agentId);
  const decision = decide({ state, config, now, agent });

  switch (decision.kind) {
    case 'pass':
      return 0;

    case 'inject':
      // Record this agent as told, so its next call passes and it can actually comply. The
      // gate stays armed for everyone else. Parallel subagents can race this read-modify-write
      // and drop an entry; the cost is one repeated instruction, so no locking.
      writeState(runDir, {
        ...state,
        pausePromptInjectedTo: [...state.pausePromptInjectedTo, agent],
      });
      emit({ hookEventName: 'PreToolUse', additionalContext: decision.text });
      return 0;

    case 'halt':
      return halt(runDir, state, sessionId, decision.reason);
  }
}
