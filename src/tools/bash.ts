import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { z } from 'zod';
import { LineCapper } from './output-cap.ts';
import { defineTool } from './types.ts';

export const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** How long to keep reading after the shell exits, for output still in the pipe. */
const DRAIN_GRACE_MS = 250;
const IS_WINDOWS = process.platform === 'win32';

const SECRET_NAME = /_(KEY|TOKEN|SECRET)$/i;

/** The environment for commands: everything except variables that look like credentials. */
export function scrubEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) out[name] = value;
  }
  return out;
}

let posixShell: string | null | undefined;

/**
 * bash (or sh) to run commands with, or null when there is none. On Windows that means Git
 * Bash: System32\bash.exe is the WSL launcher and WindowsApps holds a store stub, so both
 * are skipped even when they come first on PATH.
 */
export function findPosixShell(): string | null {
  if (posixShell !== undefined) return posixShell;
  if (!IS_WINDOWS) {
    posixShell = Bun.which('bash') ?? '/bin/sh';
    return posixShell;
  }
  const onPath = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, 'bash.exe'));
  const gitInstalls = [
    process.env.ProgramFiles,
    process.env.ProgramW6432,
    'C:\\Program Files',
  ]
    .filter((base): base is string => base !== undefined)
    .map((base) => join(base, 'Git', 'bin', 'bash.exe'));
  posixShell =
    [...onPath, ...gitInstalls].find(
      (p) => !/system32|windowsapps/i.test(p) && existsSync(p),
    ) ?? null;
  return posixShell;
}

function shellCommand(command: string): string[] {
  const shell = findPosixShell();
  if (shell) return [shell, '-c', command];
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ];
}

/** Kills the command and everything it started: its process group, or its tree on Windows. */
export function killTree(pid: number): void {
  if (IS_WINDOWS) {
    Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  capper: LineCapper,
  stop: Promise<void>,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const stopped = stop.then(() => ({ done: true as const, value: undefined }));
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      capper.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    capper.push(decoder.decode());
    capper.end();
    reader.cancel().catch(() => {});
  }
}

function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

export const bashTool = defineTool({
  name: 'bash',
  kind: 'shell',
  description:
    'Run a shell command in the project root. Output keeps the first 100 and last 200 lines. Commands are killed (with their child processes) at the timeout; there is no stdin, so pass flags that avoid prompts.',
  schema: z.object({
    command: z.string().min(1).describe('The command to run'),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe(
        `Kill the command after this many milliseconds. Default ${DEFAULT_TIMEOUT_MS}`,
      ),
  }),
  async run(
    { command, timeout_ms = DEFAULT_TIMEOUT_MS },
    { projectRoot, signal },
  ) {
    if (signal.aborted)
      return { ok: false, output: 'Interrupted by user before this ran.' };

    const proc = Bun.spawn(shellCommand(command), {
      cwd: projectRoot,
      env: scrubEnv(process.env),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Its own process group, so one kill reaches every child.
      detached: !IS_WINDOWS,
    });

    let timedOut = false;
    let interrupted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc.pid);
    }, timeout_ms);
    const onAbort = () => {
      interrupted = true;
      killTree(proc.pid);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    let stopReading = () => {};
    const stop = new Promise<void>((resolve) => {
      stopReading = resolve;
    });
    const stdout = new LineCapper();
    const stderr = new LineCapper();
    const pumps = Promise.all([
      pump(proc.stdout, stdout, stop),
      pump(proc.stderr, stderr, stop),
    ]);

    let exitCode: number | null;
    try {
      exitCode = await proc.exited;
      // Background children can hold the pipes open after the shell exits: read what's
      // already there, then kill the group and stop reading.
      await Promise.race([pumps, Bun.sleep(DRAIN_GRACE_MS)]);
      killTree(proc.pid);
      stopReading();
      await pumps;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }

    let body = stdout.render();
    if (stderr.lineCount > 0)
      body += `${body === '' ? '' : '\n'}--- stderr ---\n${stderr.render()}`;
    if (body === '') body = '(no output)';

    if (interrupted) {
      return {
        ok: false,
        output: `Interrupted by user; the command was killed.\n${body}`,
      };
    }
    if (timedOut) {
      return {
        ok: false,
        output: `Timed out after ${seconds(timeout_ms)}; the command and its child processes were killed.\n${body}`,
        hint: 'If it needs longer, pass a larger timeout_ms. If it was waiting for input, pass flags that make it non-interactive.',
      };
    }
    const status =
      exitCode === null ? 'Killed by a signal.' : `Exit code ${exitCode}.`;
    return { ok: exitCode === 0, output: `${status}\n${body}` };
  },
});
