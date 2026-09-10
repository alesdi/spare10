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
    default:
      process.stderr.write(`spare10: unknown command ${command ?? '(none)'}\n`);
      return 1;
  }
}

process.exit(main(process.argv.slice(2)));
