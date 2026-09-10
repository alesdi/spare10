import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, type ParsedArgs } from './args';
import { buildSettings, readChainTarget } from './settings';
import { configPath } from './state';

const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const runsRoot = () => join(homedir(), '.spare10', 'runs');
export const claudeSettingsPath = () => join(homedir(), '.claude', 'settings.json');

/** Old run directories are only useful for post-mortems; drop them after a week. */
function pruneOldRuns(root: string, now: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > RUN_RETENTION_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      /* a run we cannot stat or remove is not worth failing a launch over */
    }
  }
}

function createRunDir(root: string): string {
  const id = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function selfPath(): string {
  return fileURLToPath(import.meta.url);
}

export function runLaunch({ config, command }: ParsedArgs): number {
  const [executable, ...rest] = command as [string, ...string[]];

  // spare10 injects Claude Code's own settings; pointing it at anything else would hand a
  // --settings flag to a program that does not understand one.
  if (basename(executable) !== 'claude') {
    throw new UsageError(
      `spare10 wraps the "claude" command, but got "${executable}". ` +
        `Run it as: ${['spare10', ...rest, 'claude'].join(' ')}`,
    );
  }

  const root = runsRoot();
  pruneOldRuns(root, Date.now());
  const runDir = createRunDir(root);

  const chain = readChainTarget(claudeSettingsPath());
  writeFileSync(configPath(runDir), JSON.stringify({ ...config, chain: chain.command }, null, 2));

  const settings = buildSettings({
    nodePath: process.execPath,
    selfPath: selfPath(),
    runDir,
    refresh: config.refresh,
    padding: chain.padding,
  });

  // Claude Code owns the terminal from here. Let it handle Ctrl-C rather than dying first and
  // leaving the child orphaned with the TTY in raw mode.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  process.on('SIGTERM', ignore);

  const result = spawnSync(executable, ['--settings', JSON.stringify(settings), ...rest], {
    stdio: 'inherit',
  });

  if (result.error) {
    process.stderr.write(`spare10: could not start ${executable}: ${result.error.message}\n`);
    return 127;
  }
  if (result.signal) return 128 + (result.signal === 'SIGINT' ? 2 : 15);
  return result.status ?? 0;
}
