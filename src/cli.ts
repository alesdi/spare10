import { parseArgs, UsageError, USAGE } from './args';
import { runGate, runPost } from './gate';
import { runLaunch } from './launch';
import { runSensor } from './sensor';

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;

  switch (command) {
    case 'sensor': {
      const runDir = flagValue(rest, '--run');
      if (!runDir) return 0; // fail open: a misconfigured sensor must not break the status line
      return runSensor(runDir);
    }

    case 'gate': {
      const runDir = flagValue(rest, '--run');
      if (!runDir) return 0; // fail open: a misconfigured gate must never block a tool call
      return runGate(runDir);
    }

    case 'post': {
      const runDir = flagValue(rest, '--run');
      if (!runDir) return 0;
      return runPost(runDir);
    }
    default:
      return runLaunch(parseArgs(argv));
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(error.message ? `spare10: ${error.message}\n\n${USAGE}\n` : `${USAGE}\n`);
    process.exit(error.message ? 2 : 0);
  }
  throw error;
}
