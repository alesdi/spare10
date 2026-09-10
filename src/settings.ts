import { readFileSync } from 'node:fs';

/** POSIX single-quote escaping. Status line and hook commands are run through a shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ChainTarget {
  command: string | null;
  /** Preserved from the user's own configuration so their layout is not disturbed. */
  padding: number | undefined;
}

/**
 * Find the status line spare10 is about to replace.
 *
 * `statusLine` is not a hook, so it does not merge across settings levels — the one we inject
 * via --settings wins outright. Chaining is therefore mandatory, not a courtesy.
 *
 * v1 reads user-level settings only; project and local overrides are not yet resolved.
 */
export function readChainTarget(settingsPath: string): ChainTarget {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return { command: null, padding: undefined };
  }
  if (typeof parsed !== 'object' || parsed === null) return { command: null, padding: undefined };

  const statusLine = (parsed as Record<string, unknown>)['statusLine'];
  if (typeof statusLine !== 'object' || statusLine === null) {
    return { command: null, padding: undefined };
  }

  const entry = statusLine as Record<string, unknown>;
  const command = typeof entry['command'] === 'string' ? entry['command'] : null;
  const padding = typeof entry['padding'] === 'number' ? entry['padding'] : undefined;

  // Refuse to chain into ourselves — a nested spare10 would recurse once per refresh.
  if (command !== null && command.includes('spare10')) return { command: null, padding };

  return { command, padding };
}

export interface SettingsInput {
  /** Absolute path to the node binary running spare10. */
  nodePath: string;
  /** Absolute path to spare10's own bundle. */
  selfPath: string;
  /** Absolute path to this run's directory. */
  runDir: string;
  refresh: number;
  padding: number | undefined;
}

/**
 * The JSON handed to `claude --settings`. Hooks merge with the user's existing ones rather
 * than replacing them, so anything already configured keeps working.
 */
export function buildSettings(input: SettingsInput): Record<string, unknown> {
  const invoke = (subcommand: string) =>
    `${shellQuote(input.nodePath)} ${shellQuote(input.selfPath)} ${subcommand} --run ${shellQuote(input.runDir)}`;

  const hook = (subcommand: string) => [
    { matcher: '', hooks: [{ type: 'command', command: invoke(subcommand) }] },
  ];

  const statusLine: Record<string, unknown> = {
    type: 'command',
    command: invoke('sensor'),
    refreshInterval: input.refresh,
  };
  if (input.padding !== undefined) statusLine['padding'] = input.padding;

  return {
    statusLine,
    hooks: {
      PreToolUse: hook('gate'),
      PostToolUse: hook('post'),
      UserPromptSubmit: hook('notice'),
    },
  };
}
