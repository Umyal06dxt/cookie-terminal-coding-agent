#!/usr/bin/env bun
/**
 * Records one real `cookie -p` run for replay in tests. Costs real credits; run by hand only,
 * never from tests or CI.
 *
 *   bun scripts/record.ts --model deepseek-v4.1-flash --task "fix the failing test" --repo ../tunyt
 *
 * The run happens in a throwaway copy of --repo (git repos are cloned at HEAD, so uncommitted
 * changes are left out) with --yes. Output: test/fixtures/recordings/<model>/<task-slug>.jsonl,
 * with header values and anything key-shaped stripped.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  copyRepo,
  failureReason,
  preflight,
  recordRun,
  type ScriptIo,
} from './lib/record-run.ts';
import { safeName } from './lib/recording.ts';

export const RECORDINGS_DIR = join(
  import.meta.dir,
  '..',
  'test',
  'fixtures',
  'recordings',
);

const HELP = `Usage: bun scripts/record.ts --model <id> --task "<task>" --repo <path> [--max-turns N] [--out <dir>]

Runs cookie -p "<task>" --yes with <id> in a throwaway copy of <path> and records every request
and streamed chunk to <out>/<model>/<task-slug>.jsonl (default out: test/fixtures/recordings).
Git repos are cloned at HEAD: uncommitted changes are not included.
`;

export async function recordMain(
  argv: readonly string[],
  io: ScriptIo & { outDir?: string } = {},
): Promise<number> {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let values: {
    model?: string;
    task?: string;
    repo?: string;
    'max-turns'?: string;
    out?: string;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        model: { type: 'string' },
        task: { type: 'string' },
        repo: { type: 'string' },
        'max-turns': { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
    return 2;
  }
  if (values.help) {
    (io.out ?? ((t: string) => process.stdout.write(t)))(HELP);
    return 0;
  }
  const { model, task, repo } = values;
  if (!model || !task?.trim() || !repo) {
    err(`--model, --task and --repo are all required.\n${HELP}`);
    return 2;
  }
  const maxTurns = Number(values['max-turns'] ?? 12);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    err('--max-turns must be a whole number above 0.\n');
    return 2;
  }

  const file = join(
    resolve(values.out ?? io.outDir ?? RECORDINGS_DIR),
    safeName(model),
    `${safeName(task)}.jsonl`,
  );
  const setup = preflight({ ...io, cwd: resolve(repo) });
  if (!setup.ok) {
    err(`record: ${setup.message}\n`);
    return 1;
  }
  const copy = copyRepo(resolve(repo));
  try {
    const { code, stderr } = await recordRun({
      model,
      task,
      cwd: copy.dir,
      repoHead: copy.head,
      file,
      maxTurns,
      io,
    });
    const ok = code === 0 || code === 3;
    err(
      ok
        ? `recorded ${file} (cookie exited ${code})\n`
        : `cookie failed (exit ${code}): ${failureReason(code, stderr)}\nrecording: ${file}\n`,
    );
    return code;
  } finally {
    copy.cleanup();
  }
}

if (import.meta.main) {
  process.exitCode = await recordMain(Bun.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
