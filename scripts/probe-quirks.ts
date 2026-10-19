#!/usr/bin/env bun
/**
 * Sends each configured model 12 short tasks built to provoke tool-call mistakes, records every
 * run, and prints model × tool × {valid, invalid, which zod issue}. Costs real credits (36 short
 * runs for three models); run by hand only, never from tests or CI.
 *
 *   bun scripts/probe-quirks.ts                                  # every model, every task
 *   bun scripts/probe-quirks.ts --model gpt-5.6-luna --task 1    # one probe, to check setup
 *
 * Cookie runs in this process and reads COMMANDCODE_API_KEY from this shell's environment, so
 * the key must be exported (an alias that sets it only for `cookie` isn't enough).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  analyzeRecording,
  formatTable,
  PROBE_TASKS,
  PROBE_TOOLS,
  type TableRow,
  tally,
  writeProbeRepo,
} from './lib/probe.ts';
import {
  failureReason,
  preflight,
  type RecordResult,
  recordRun,
  type ScriptIo,
} from './lib/record-run.ts';
import { loadRecording, safeName } from './lib/recording.ts';
import { RECORDINGS_DIR } from './record.ts';

/** Turns per probe: enough for a call, its error and one retry. */
export const PROBE_MAX_TURNS = 3;
/** This many failed runs in a row means setup is broken, not the model: stop spending. */
export const MAX_FAILURES_IN_A_ROW = 3;

/** "--task 1 --task 12" → [0, 11]; null when a value isn't 1–12. */
export function taskIndexes(
  values: readonly string[] | undefined,
): number[] | null {
  if (!values) return PROBE_TASKS.map((_, i) => i);
  const indexes = values.map((v) => Number(v) - 1);
  return indexes.every(
    (i) => Number.isInteger(i) && i >= 0 && i < PROBE_TASKS.length,
  )
    ? indexes
    : null;
}

export async function probeMain(
  argv: readonly string[],
  io: ScriptIo & { outDir?: string; cwd?: string } = {},
): Promise<number> {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let values: { model?: string[]; task?: string[] };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        model: { type: 'string', multiple: true },
        task: { type: 'string', multiple: true },
      },
      strict: true,
    }));
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const tasks = taskIndexes(values.task);
  if (tasks === null) {
    err(`--task must be a number from 1 to ${PROBE_TASKS.length}.\n`);
    return 2;
  }
  const setup = preflight(io);
  if (!setup.ok) {
    err(`probe-quirks: ${setup.message}\n`);
    return 1;
  }
  const models = values.model ?? [
    ...new Set(Object.values(setup.config.models)),
  ];
  const outDir = io.outDir ?? RECORDINGS_DIR;

  const rows: TableRow[] = [];
  const failed: string[] = [];
  let inARow = 0;
  for (const model of models) {
    for (const i of tasks) {
      const probe = PROBE_TASKS[i];
      if (!probe) continue;
      const label = `${model} · probe ${i + 1}/${PROBE_TASKS.length} · ${probe.provokes}`;
      const file = join(
        outDir,
        safeName(model),
        `probe-${String(i + 1).padStart(2, '0')}-${safeName(probe.task)}.jsonl`,
      );
      const repo = mkdtempSync(join(tmpdir(), 'cookie-probe-'));
      let result: RecordResult;
      try {
        writeProbeRepo(repo);
        err(`${label}\n`);
        result = await recordRun({
          model,
          task: probe.task,
          cwd: repo,
          repoHead: null,
          file,
          maxTurns: PROBE_MAX_TURNS,
          tools: PROBE_TOOLS,
          // Cookie's own output goes into the recording; the probe prints only reasons.
          io: { ...io, out: () => {}, err: () => {} },
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
      // 0 done, 3 max turns: both are fine for a probe. Anything else means it never really ran.
      if (result.code !== 0 && result.code !== 3) {
        const reason = failureReason(result.code, result.stderr);
        failed.push(`${label}: ${reason}`);
        err(`  ✗ failed (exit ${result.code}): ${reason}\n`);
        inARow++;
        if (inARow >= MAX_FAILURES_IN_A_ROW) {
          err(
            `\nStopped after ${inARow} failed runs in a row: that's a setup problem, not the models.\n` +
              `Last reason: ${reason}\nRecording: ${file}\n`,
          );
          if (rows.length > 0) out(`${formatTable(rows)}\n`);
          return 1;
        }
        continue;
      }
      inARow = 0;
      tally(model, await analyzeRecording(loadRecording(file)), rows);
    }
  }
  out(`${formatTable(rows)}\n`);
  if (failed.length > 0) {
    err(
      `\n${failed.length} probe run(s) failed:\n${failed.map((f) => `  ${f}`).join('\n')}\n`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await probeMain(Bun.argv.slice(2));
}
