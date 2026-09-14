/** Tolerant parsing of hook stdin. Only the fields the gate actually needs. */
export interface HookPayload {
  sessionId: string | null;
  toolName: string | null;
  /** Present only when the hook fired inside a subagent. */
  agentId: string | null;
}

const EMPTY: HookPayload = { sessionId: null, toolName: null, agentId: null };

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const obj = parsed as Record<string, unknown>;
    return {
      sessionId: typeof obj['session_id'] === 'string' ? obj['session_id'] : null,
      toolName: typeof obj['tool_name'] === 'string' ? obj['tool_name'] : null,
      agentId: typeof obj['agent_id'] === 'string' ? obj['agent_id'] : null,
    };
  } catch {
    return EMPTY;
  }
}
