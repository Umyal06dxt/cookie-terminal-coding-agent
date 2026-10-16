import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

async function cookie(...args: string[]) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
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
});
