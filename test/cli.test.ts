import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const BUNDLE = join(__dirname, '..', 'dist', 'spare10.js');

beforeAll(() => {
  execFileSync('node', [join(__dirname, '..', 'scripts', 'build.mjs')], { stdio: 'pipe' });
}, 30_000);

const run = (...args: string[]) =>
  spawnSync('node', [BUNDLE, ...args], { encoding: 'utf8', input: '' });

describe('the command line', () => {
  it.each([['--help'], ['-h']])('prints help on stdout for %s, and exits zero', (flag) => {
    const result = run(flag);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('spare10 — pause Claude Code');
    expect(result.stderr).toBe('');
  });

  it('sends a usage error to stderr and exits non-zero', () => {
    const result = run('--reserve', 'banana', 'claude');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('whole number');
    expect(result.stdout).toBe('');
  });

  it('explains itself when given no command at all', () => {
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No command given');
  });
});
