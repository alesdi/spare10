import { DEFAULT_CONFIG, type Limit, type RunConfig } from './types';

export interface ParsedArgs {
  config: Omit<RunConfig, 'chain'>;
  /** The command to run, plus its arguments. Everything after the first non-flag token. */
  command: string[];
}

export class UsageError extends Error {}

export const USAGE = `spare10 — pause Claude Code before the session or weekly quota runs out

  spare10 [options] <command> [args...]

Options:
  --reserve <1-99>      Keep this much of both limits back for yourself (default: 10)
  --session-reserve <1-99>
                        Override the reserve for the 5-hour session limit only
  --weekly-reserve <1-99>
                        Override the reserve for the weekly limit only
  --pause-prompt <text> Instead of stopping, inject this instruction into the running agent
  --refresh <seconds>   Status line poll interval, also the staleness unit (default: 5)
  --no-badge            Never draw the spare10 marker in the status line
  -h, --help            Show this message

Commands:
  doctor                Report what spare10 detected and what it would do

Examples:
  spare10 claude
  spare10 --reserve 15 claude
  spare10 --weekly-reserve 5 claude
  spare10 --pause-prompt "Finish this block, commit, then stop." claude --resume`;

function parseReserve(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(
      `${flag} must be a whole number: the API reports quota in integer percentages, ` +
        `so "${raw}" cannot be honoured.`,
    );
  }
  const value = Number(raw);
  if (value < 1 || value > 99) {
    throw new UsageError(`${flag} must be between 1 and 99, got ${value}.`);
  }
  return value;
}

function parseRefresh(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new UsageError(`--refresh must be a whole number of seconds >= 1, got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Flags are consumed up to the first non-flag token; everything from there is the command.
 *
 * `--reserve` sets both limits and `--session-reserve`/`--weekly-reserve` one each. The specific
 * flag wins whichever comes first, so they are gathered apart and only resolved at the end.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let general: number | null = null;
  const specific: Partial<Record<Limit, number>> = {};
  const config = {
    reserve: { ...DEFAULT_CONFIG.reserve },
    pausePrompt: DEFAULT_CONFIG.pausePrompt,
    refresh: DEFAULT_CONFIG.refresh,
    badge: DEFAULT_CONFIG.badge,
  };

  let index = 0;
  const next = (flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new UsageError(`${flag} requires a value.`);
    index += 1;
    return value;
  };

  for (; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-')) break;

    switch (token) {
      case '--reserve':
        general = parseReserve(token, next(token));
        break;
      case '--session-reserve':
        specific.session = parseReserve(token, next(token));
        break;
      case '--weekly-reserve':
        specific.weekly = parseReserve(token, next(token));
        break;
      case '--threshold':
        // spare10 talks in reserve, not usage. Point people at the flag that exists.
        throw new UsageError(
          `--threshold was replaced by --reserve, which is the quota kept back rather than ` +
            `the level that trips. "--threshold 90" is now "--reserve 10".`,
        );
      case '--pause-prompt':
        config.pausePrompt = next(token);
        break;
      case '--refresh':
        config.refresh = parseRefresh(next(token));
        break;
      case '--no-badge':
        config.badge = false;
        break;
      case '-h':
      case '--help':
        throw new UsageError('');
      default:
        throw new UsageError(`Unknown option "${token}".`);
    }
  }

  config.reserve = {
    session: specific.session ?? general ?? DEFAULT_CONFIG.reserve.session,
    weekly: specific.weekly ?? general ?? DEFAULT_CONFIG.reserve.weekly,
  };

  const command = argv.slice(index);
  if (command.length === 0) {
    throw new UsageError('No command given. Try: spare10 claude');
  }
  return { config, command };
}
