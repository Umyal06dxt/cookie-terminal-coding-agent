import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bashTool, findPosixShell, scrubEnv } from '../../src/tools/bash.ts';
import { call, IS_WINDOWS, tempProject, useTempProjects } from './helpers.ts';

useTempProjects();

type Project = ReturnType<typeof tempProject>;
/** These tests use POSIX shell syntax; Windows runners without Git Bash skip them. */
const NO_POSIX_SHELL = findPosixShell() === null;
const bash = (p: Project, args: object, signal?: AbortSignal) =>
  call(bashTool, args, p.ctx(signal));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A killed process can linger briefly before the kernel reaps it. */
async function waitUntilDead(pid: number, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(20);
  }
  return !isAlive(pid);
}

describe('bash', () => {
  test.skipIf(NO_POSIX_SHELL)(
    'runs in the project root and returns the exit code',
    async () => {
      const p = tempProject({ 'marker.txt': 'here' });
      const result = await bash(p, { command: 'cat marker.txt' });
      expect(result).toEqual({ ok: true, output: 'Exit code 0.\nhere' });
    },
  );

  test.skipIf(NO_POSIX_SHELL)(
    'a failing command is ok:false with its exit code and stderr',
    async () => {
      const p = tempProject();
      const result = await bash(p, {
        command: 'echo out; echo "Error: bad" >&2; exit 3',
      });
      expect(result.ok).toBe(false);
      expect(result.output).toBe(
        'Exit code 3.\nout\n--- stderr ---\nError: bad',
      );
    },
  );

  test.skipIf(NO_POSIX_SHELL)('a command with no output says so', async () => {
    expect((await bash(tempProject(), { command: 'true' })).output).toBe(
      'Exit code 0.\n(no output)',
    );
  });

  test.skipIf(NO_POSIX_SHELL)(
    'stdin is closed, so a prompt gets EOF instead of hanging',
    async () => {
      const result = await bash(tempProject(), {
        command: 'read answer; echo "got:$answer"',
        timeout_ms: 5000,
      });
      expect(result.output).toContain('got:');
    },
  );

  test.skipIf(NO_POSIX_SHELL)(
    'a command that hangs is killed at the timeout',
    async () => {
      const started = Date.now();
      const result = await bash(tempProject(), {
        command: 'echo before; sleep 30',
        // Generous enough for Git Bash to start on Windows runners.
        timeout_ms: 1500,
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.ok).toBe(false);
      expect(result.output).toStartWith(
        'Timed out after 1.5s; the command and its child processes were killed.',
      );
      expect(result.output).toContain('before');
      expect(result.hint).toContain('timeout_ms');
    },
    10_000,
  );

  test.skipIf(IS_WINDOWS)(
    'the timeout kills the whole process group, not just the shell',
    async () => {
      const p = tempProject();
      await bash(p, {
        command: 'sleep 30 & echo $! > child.pid; wait',
        timeout_ms: 300,
      });
      const pid = Number(readFileSync(p.path('child.pid'), 'utf8').trim());
      expect(pid).toBeGreaterThan(0);
      expect(await waitUntilDead(pid)).toBe(true);
    },
    10_000,
  );

  test.skipIf(IS_WINDOWS)(
    'returns promptly when a background child keeps the pipes open',
    async () => {
      const p = tempProject();
      const started = Date.now();
      const result = await bash(p, {
        command: 'sleep 30 & echo $! > bg.pid; echo started',
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.output).toBe('Exit code 0.\nstarted');
      const pid = Number(readFileSync(p.path('bg.pid'), 'utf8').trim());
      expect(await waitUntilDead(pid)).toBe(true);
    },
    10_000,
  );

  test.skipIf(NO_POSIX_SHELL)(
    'an abort kills the command',
    async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      const result = await bash(
        tempProject(),
        { command: 'sleep 30' },
        controller.signal,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.output).toStartWith(
        'Interrupted by user; the command was killed.',
      );
    },
    10_000,
  );

  test.skipIf(NO_POSIX_SHELL)(
    'huge output keeps the first 100 and last 200 lines',
    async () => {
      const result = await bash(tempProject(), {
        command: 'for i in $(seq 1 1000); do echo "row $i"; done',
      });
      const lines = result.output.split('\n');
      expect(lines[1]).toBe('row 1');
      expect(lines[100]).toBe('row 100');
      expect(lines[101]).toBe('… 700 lines dropped …');
      expect(lines.at(-1)).toBe('row 1000');
    },
  );

  test.skipIf(NO_POSIX_SHELL)(
    'secrets are removed from the environment',
    async () => {
      process.env.COOKIE_TEST_SECRET = 'should-not-leak';
      process.env.COOKIE_TEST_TOKEN = 'nor-this';
      process.env.COOKIE_TEST_PLAIN = 'visible';
      try {
        const result = await bash(tempProject(), {
          command:
            'echo "[$COOKIE_TEST_SECRET][$COOKIE_TEST_TOKEN][$COOKIE_TEST_PLAIN]"',
        });
        expect(result.output).toBe('Exit code 0.\n[][][visible]');
      } finally {
        delete process.env.COOKIE_TEST_SECRET;
        delete process.env.COOKIE_TEST_TOKEN;
        delete process.env.COOKIE_TEST_PLAIN;
      }
    },
  );

  test('scrubEnv drops *_KEY, *_TOKEN and *_SECRET names', () => {
    expect(
      scrubEnv({
        COMMANDCODE_API_KEY: 'k',
        GH_TOKEN: 't',
        AWS_SECRET: 's',
        PATH: '/bin',
        KEYBOARD: 'x',
        HOME: undefined,
      }),
    ).toEqual({ PATH: '/bin', KEYBOARD: 'x' });
  });
});
