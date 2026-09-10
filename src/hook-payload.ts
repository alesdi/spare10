/** Tolerant parsing of hook stdin. Only the fields the gate actually needs. */
export interface HookPayload {
  permissionMode: string | null;
  toolName: string | null;
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { permissionMode: null, toolName: null };
    const obj = parsed as Record<string, unknown>;
    return {
      permissionMode: typeof obj['permission_mode'] === 'string' ? obj['permission_mode'] : null,
      toolName: typeof obj['tool_name'] === 'string' ? obj['tool_name'] : null,
    };
  } catch {
    return { permissionMode: null, toolName: null };
  }
}
