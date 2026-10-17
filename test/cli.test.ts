import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };
import { parseCli } from '../src/cli.ts';
import { scrubEnv } from '../src/tools/bash.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// An empty home and cwd with no API key: no config is found, so nothing can reach the network.
const sandbox = mkdtempSync(join(tmpdir(), 'cookie-cli-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
// scrubEnv drops every *_KEY/*_TOKEN/*_SECRET by name, so the key's value is never touched here.
const baseEnv = scrubEnv(process.env);

async function cookie(...args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: sandbox,
    env: { ...baseEnv, HOME: sandbox, USERPROFILE: sandbox },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('cookie CLI', () => {
  test.each(['--version', '-v'])(
    '%s prints the package.json version',
    async (flag) => {
      const { code, stdout, stderr } = await cookie(flag);
      expect(code).toBe(0);
      expect(stdout.trim()).toBe(pkg.version);
      expect(stderr).toBe('');
    },
  );

  test.each(['--help', '-h'])('%s prints usage', async (flag) => {
    const { code, stdout, stderr } = await cookie(flag);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--help');
    expect(stdout).toContain('--version');
    expect(stderr).toBe('');
  });

  test('an unknown flag names the flag, points to --help and exits 2', async () => {
    const { code, stdout, stderr } = await cookie('--bogus');
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain("unknown option '--bogus'");
    expect(stderr).toContain('cookie --help');
  });

  test('an unexpected argument exits 2', async () => {
    const { code, stderr } = await cookie('bake');
    expect(code).toBe(2);
    expect(stderr).toContain("unexpected argument 'bake'");
  });

  test('--help lists the headless flags', async () => {
    const { stdout } = await cookie('--help');
    for (const flag of ['-p, --print', '--json', '--yes']) {
      expect(stdout).toContain(flag);
    }
  });

  test.each([
    [['-p'], 'argument missing'],
    [['-p', '   '], '-p needs a task'],
    [['--json'], '--json only works with -p'],
    [['--yes'], '--yes only works with -p'],
    [['-p', 'fix it', 'extra'], "unexpected argument 'extra'"],
  ])('bad usage %j exits 2', async (args, message) => {
    const { code, stdout, stderr } = await cookie(...args);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(message);
  });

  test('-p without a config exits 1 and says what is missing', async () => {
    const { code, stdout, stderr } = await cookie(
      '-p',
      'fix the test',
      '--yes',
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('cookie.toml');
  });
});

describe('cookie with no arguments', () => {
  test('parses as the interactive UI', () => {
    expect(parseCli([])).toEqual({ kind: 'interactive', resume: null });
  });

  test('--resume picks a session, --continue takes the newest', () => {
    expect(parseCli(['--resume'])).toEqual({
      kind: 'interactive',
      resume: 'pick',
    });
    expect(parseCli(['-r'])).toEqual({ kind: 'interactive', resume: 'pick' });
    expect(parseCli(['--continue'])).toEqual({
      kind: 'interactive',
      resume: 'latest',
    });
    expect(parseCli(['-c'])).toEqual({ kind: 'interactive', resume: 'latest' });
  });

  test.each([
    [['--resume', '--continue'], 'not both'],
    [['-p', 'x', '--continue'], "doesn't work with -p"],
  ])('bad resume usage %j exits 2', (args, message) => {
    const parsed = parseCli(args);
    if (parsed.kind !== 'result') throw new Error('expected a usage error');
    expect(parsed.result.code).toBe(2);
    expect(parsed.result.stderr).toContain(message);
  });

  test('without a terminal it prints usage and explains, instead of failing in raw mode', async () => {
    const { code, stdout, stderr } = await cookie();
    expect(code).toBe(2);
    expect(stdout).toContain('Usage:');
    expect(stderr).toContain('needs a terminal');
  });
});
