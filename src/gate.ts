import { readFileSync } from 'node:fs';
import { decide, isTripped, noticeText } from './decide';
import { parseHookPayload } from './hook-payload';
import { disarmUntil, nowSeconds, readRunConfig, readState, writeState } from './state';

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

export function runGate(runDir: string): number {
  const config = readRunConfig(runDir);
  const state = readState(runDir);
  const now = nowSeconds();

  // Hot path. On the overwhelming majority of tool calls the answer is "pass", and reaching it
  // costs one small file read — the payload is never parsed.
  if (decide({ state, config, now, permissionMode: null }).kind === 'pass') {
    drainStdin();
    return 0;
  }

  const { permissionMode } = parseHookPayload(drainStdin());
  const decision = decide({ state, config, now, permissionMode });

  switch (decision.kind) {
    case 'pass':
      return 0;

    case 'inject':
      // Disarm immediately: the agent has just been told to commit and stop, and it cannot
      // comply if the next tool call is gated too.
      writeState(runDir, {
        ...state,
        pausePromptInjected: true,
        disarmedUntil: disarmUntil(state, now),
      });
      emit({ hookEventName: 'PreToolUse', additionalContext: decision.text });
      return 0;

    case 'ask':
      // A hook cannot observe the outcome of the dialog. If the user approves, the tool runs
      // and PostToolUse fires; if they press Esc, it never does. That is the disarm signal.
      writeState(runDir, { ...state, awaitingApproval: true });
      emit({
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: decision.reason,
      });
      return 0;

    case 'deny':
      emit({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      });
      return 0;
  }
}

/**
 * UserPromptSubmit. It cannot block — exit code 2 would erase what the user typed — so it only
 * speaks. Plain stdout on this event is added as context both the user and Claude can see.
 */
export function runNotice(runDir: string): number {
  drainStdin();
  const config = readRunConfig(runDir);
  const state = readState(runDir);
  if (!isTripped(state, config, nowSeconds())) return 0;

  process.stdout.write(noticeText(state, config));
  return 0;
}

export function runPost(runDir: string): number {
  drainStdin();
  const state = readState(runDir);
  if (!state.awaitingApproval) return 0;

  writeState(runDir, {
    ...state,
    awaitingApproval: false,
    disarmedUntil: disarmUntil(state, nowSeconds()),
  });
  return 0;
}
