import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { loadConfig } from '../../src/config/load.ts';
import type { CookieConfig } from '../../src/config/schema.ts';
import { headlessMain } from '../../src/headless/main.ts';
import type { FetchLike } from '../../src/provider/client.ts';
import { redact } from '../../src/storage/redact.ts';
import type { Tool } from '../../src/tools/types.ts';
import { createRecorder, fileSink } from './recording.ts';

export type Write = (text: string) => void;

/** What the scripts need from the outside world; tests pass fakes for all of it. */
export interface ScriptIo {
  env?: Record<string, string | undefined>;
  /** Wrapped by the recorder; the real fetch by default. */
  fetch?: FetchLike;
  /** Home folder for the user cookie.toml. */
  home?: string;
  catalogCache?: string;
  out?: Write;
  err?: Write;
}

function git(cwd: string, args: string[]): string | null {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/**
 * A throwaway copy of `repo`, because a recorded run edits files and runs commands (--yes).
 * A git repo is cloned at HEAD, so uncommitted changes are NOT included; anything else is
 * copied without node_modules. The project's .cookie/cookie.toml comes along either way.
 */
export function copyRepo(repo: string): {
  dir: string;
  head: string | null;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cookie-record-'));
  const head = git(repo, ['rev-parse', 'HEAD']);
  if (head !== null) {
    const cloned = Bun.spawnSync(
      ['git', 'clone', '-q', '--no-hardlinks', repo, dir],
      {
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    if (cloned.exitCode !== 0)
      throw new Error(`git clone failed: ${cloned.stderr.toString().trim()}`);
  } else {
    cpSync(repo, dir, {
      recursive: true,
      filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
    });
  }
  const config = join(repo, '.cookie', 'cookie.toml');
  if (existsSync(config)) {
    mkdirSync(join(dir, '.cookie'), { recursive: true });
    cpSync(config, join(dir, '.cookie', 'cookie.toml'));
  }
  return {
    dir,
    head,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface RecordRunOptions {
  model: string;
  task: string;
  /** The working copy to run in (already a throwaway copy). */
  cwd: string;
  repoHead: string | null;
  /** The .jsonl to write; replaced if it exists. */
  file: string;
  maxTurns: number;
  /** Extra tools for the probe; the default five otherwise. */
  tools?: Tool[];
  io: ScriptIo;
}

/** The last thing Cookie said on stderr: why a run failed, in one line. */
export function failureReason(code: number, stderr: string): string {
  const last = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1);
  if (last === undefined) return `exit code ${code}, nothing on stderr`;
  return last.replace(/^cookie: /, '');
}

export interface RecordResult {
  code: number;
  /** Everything Cookie printed on stderr. */
  stderr: string;
}

/**
 * Runs `cookie -p <task> --yes` (the real headless code, in this process) with the recorder in
 * front of the provider. Cookie reads the API key from this process's environment, or `io.env`.
 * Writes nothing outside `file` and `cwd`; the file always ends with an `exit` record.
 */
export async function recordRun(
  options: RecordRunOptions,
): Promise<RecordResult> {
  const { io } = options;
  rmSync(options.file, { force: true });
  const sink = fileSink(options.file);
  sink({
    t: 'meta',
    version: 1,
    model: options.model,
    task: options.task,
    yes: true,
    maxTurns: options.maxTurns,
    cookieVersion: pkg.version,
    repoHead: options.repoHead,
    recordedAt: new Date().toISOString(),
  });
  const recorder = createRecorder(sink);
  let stderr = '';
  const err: Write = (text) => {
    stderr += text;
    io.err?.(text);
  };
  const code = await headlessMain(
    {
      task: options.task,
      json: false,
      yes: true,
      model: options.model,
      maxTurns: options.maxTurns,
    },
    {
      out: io.out ?? (() => {}),
      err,
      cwd: options.cwd,
      fetch: recorder.fetch(io.fetch ?? fetch),
      sessionLog: false,
      ...(io.env !== undefined && { env: io.env }),
      ...(io.home !== undefined && { home: io.home }),
      ...(io.catalogCache !== undefined && { catalogCache: io.catalogCache }),
      ...(options.tools !== undefined && { tools: options.tools }),
    },
  );
  await recorder.settled();
  sink({ t: 'exit', code, stderr: redact(stderr.slice(-2000)) });
  return { code, stderr };
}

/**
 * Checks what would make every run fail before spending anything: the config loads and the
 * API key's variable is set. Looks only at whether the variable is non-empty, never its value.
 */
export function preflight(
  io: ScriptIo & { cwd?: string },
): { ok: true; config: CookieConfig } | { ok: false; message: string } {
  const loaded = loadConfig({
    cwd: io.cwd ?? process.cwd(),
    ...(io.home !== undefined && { home: io.home }),
  });
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const name = loaded.config.provider.api_key_env;
  const env = io.env ?? process.env;
  if (!env[name]?.trim()) {
    return {
      ok: false,
      message:
        `${name} is not set in this script's environment, so every run would fail before calling the API.\n` +
        `A shell alias that sets it only for \`cookie\` doesn't reach other commands: run \`export ${name}=...\` in this shell (or add it to your shell profile), then rerun.`,
    };
  }
  return { ok: true, config: loaded.config };
}
