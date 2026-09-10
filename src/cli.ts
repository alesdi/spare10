import { parseArgs, UsageError, USAGE } from './args';
import { runGate, runPost } from './gate';
import { runDoctor } from './doctor-report';
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
    case 'doctor':
      return runDoctor();

    default:
      return runLaunch(parseArgs(argv));
  }
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (error) {
  if (error instanceof UsageError) {
    // Help that was asked for is output; help shown because of a mistake is a diagnostic.
    if (error.message) {
      process.stderr.write(`spare10: ${error.message}\n\n${USAGE}\n`);
      process.exit(2);
    }
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  throw error;
}
