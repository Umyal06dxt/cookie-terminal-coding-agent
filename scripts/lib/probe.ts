import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { accumulateChunks } from '../../src/provider/stream.ts';
import { createDefaultRegistry } from '../../src/tools/index.ts';
import { readTool } from '../../src/tools/read.ts';
import type { ToolRegistry } from '../../src/tools/registry.ts';
import { defineTool } from '../../src/tools/types.ts';
import type { RecordingRecord } from './recording.ts';

/**
 * None of the five real tools takes an array, so the array probes need one: read_many exists
 * only in the probe's registry, never in createDefaultRegistry.
 */
export const readManyTool = defineTool({
  name: 'read_many',
  kind: 'read',
  description:
    'Read several files in one call. file_paths is a list of paths relative to the project root.',
  schema: z.object({
    file_paths: z
      .array(z.string())
      .min(1)
      .describe('Paths to read, e.g. ["src/a.ts", "src/b.ts"]'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Lines per file. Default 2000'),
  }),
  async run({ file_paths, limit }, context) {
    const parts = [];
    for (const file_path of file_paths) {
      const result = await readTool.run(
        { file_path, ...(limit !== undefined && { limit }) },
        context,
      );
      parts.push(`== ${file_path}\n${result.output}`);
    }
    return { ok: true, output: parts.join('\n\n') };
  },
});

export const PROBE_TOOLS = [readManyTool];

export interface ProbeTask {
  /** What the task is meant to provoke. */
  provokes: string;
  task: string;
}

/** Short tasks, each aimed at one tool-call mistake budget models are known to make. */
export const PROBE_TASKS: readonly ProbeTask[] = [
  {
    provokes: 'optional field (limit)',
    task: 'Read only the first 5 lines of src/app.ts.',
  },
  {
    provokes: 'offset without limit',
    task: 'Show src/app.ts from line 20 to the end.',
  },
  {
    provokes: 'offset and limit',
    task: 'Show lines 10 through 15 of src/app.ts.',
  },
  {
    provokes: 'path with spaces',
    task: "What does 'docs/release notes.md' say?",
  },
  {
    provokes: 'Unicode path',
    task: 'Read src/café/menü.ts and tell me what it exports.',
  },
  {
    provokes: 'array argument',
    task: 'Use read_many to read src/app.ts, src/util.ts and README.md in one call.',
  },
  {
    provokes: 'single path where an array is expected',
    task: 'Use read_many to read just src/util.ts.',
  },
  {
    provokes: 'optional boolean (replace_all)',
    task: "In src/util.ts, replace every 'foo' with 'bar'.",
  },
  {
    provokes: 'number argument (timeout_ms)',
    task: 'Run `bun --version` with a timeout of 5 seconds.',
  },
  {
    provokes: 'several patterns for one string field',
    task: 'Find all Markdown files and all TypeScript files.',
  },
  {
    provokes: 'write to a path with spaces and Unicode',
    task: "Create 'notes/to do ✓.md' with a three-item checklist.",
  },
  {
    provokes: 'path with ./ and an exact edit',
    task: 'In ./src/app.ts change the greeting from Hello to Hi.',
  },
];

const APP = [
  'export function greet(name: string) {',
  "  return 'Hello, ' + name + '!';",
  '}',
  ...Array.from(
    { length: 27 },
    (_, i) => `export const line${i + 4} = ${i + 4};`,
  ),
].join('\n');

/** The small project every probe task runs in. */
export const PROBE_FILES: Record<string, string> = {
  'README.md': '# Probe\n\nA tiny project for provoking tool-call mistakes.\n',
  'package.json': '{ "name": "probe", "private": true }\n',
  'src/app.ts': `${APP}\n`,
  'src/util.ts':
    "export const foo = 'foo';\nexport const fooAgain = foo + 'foo';\n",
  'src/café/menü.ts':
    "export const menu = ['croissant', 'pain au chocolat'];\n",
  'docs/release notes.md': '# Release notes\n\n- 0.1.0: first bake\n',
};

export function writeProbeRepo(dir: string): void {
  for (const [rel, content] of Object.entries(PROBE_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** The registry the probe validates against: the default five plus read_many. */
export function probeRegistry(): ToolRegistry {
  return createDefaultRegistry().register(...PROBE_TOOLS);
}

export interface CallVerdict {
  tool: string;
  /** 'valid', or what was wrong: "invalid JSON", "unknown tool", or zod issues. */
  issues: string[];
}

async function* chunksOf(
  records: readonly RecordingRecord[],
): AsyncIterable<ChatCompletionChunk> {
  for (const r of records)
    if (r.t === 'chunk') yield r.chunk as ChatCompletionChunk;
}

/** Every tool call in a recording (retries included), checked against the tool's own schema. */
export async function analyzeRecording(
  records: readonly RecordingRecord[],
  registry: ToolRegistry = probeRegistry(),
): Promise<CallVerdict[]> {
  const verdicts: CallVerdict[] = [];
  const requests = [
    ...new Set(records.flatMap((r) => (r.t === 'chunk' ? [r.n] : []))),
  ];
  for (const n of requests) {
    const mine = records.filter((r) => r.t === 'chunk' && r.n === n);
    for await (const event of accumulateChunks(chunksOf(mine))) {
      if (event.type !== 'tool_call_end') continue;
      const tool = registry.get(event.name);
      if (!tool) {
        verdicts.push({ tool: event.name, issues: ['unknown tool'] });
        continue;
      }
      let args: unknown;
      try {
        args = event.argsJson.trim() === '' ? {} : JSON.parse(event.argsJson);
      } catch {
        verdicts.push({ tool: event.name, issues: ['invalid JSON'] });
        continue;
      }
      const parsed = tool.schema.safeParse(args ?? {});
      verdicts.push({
        tool: event.name,
        issues: parsed.success
          ? []
          : parsed.error.issues.map(
              (i) => `${i.path.join('.') || '(root)'}: ${i.code}`,
            ),
      });
    }
  }
  return verdicts;
}

export interface TableRow {
  model: string;
  tool: string;
  valid: number;
  invalid: number;
  /** Issue → how many calls had it. */
  issues: Map<string, number>;
}

export function tally(
  model: string,
  verdicts: readonly CallVerdict[],
  rows: TableRow[] = [],
): TableRow[] {
  for (const v of verdicts) {
    let row = rows.find((r) => r.model === model && r.tool === v.tool);
    if (!row) {
      row = { model, tool: v.tool, valid: 0, invalid: 0, issues: new Map() };
      rows.push(row);
    }
    if (v.issues.length === 0) row.valid++;
    else row.invalid++;
    for (const issue of new Set(v.issues))
      row.issues.set(issue, (row.issues.get(issue) ?? 0) + 1);
  }
  return rows;
}

/** Model × tool × valid / invalid / which zod issue, as a plain-text table. */
export function formatTable(rows: readonly TableRow[]): string {
  const sorted = [...rows].sort(
    (a, b) => a.model.localeCompare(b.model) || a.tool.localeCompare(b.tool),
  );
  const cells = [
    ['model', 'tool', 'valid', 'invalid', 'issues'],
    ...sorted.map((r) => [
      r.model,
      r.tool,
      String(r.valid),
      String(r.invalid),
      [...r.issues].map(([issue, count]) => `${issue} ×${count}`).join(', ') ||
        '—',
    ]),
  ];
  const widths =
    cells[0]?.map((_, col) =>
      Math.max(...cells.map((row) => (row[col] ?? '').length)),
    ) ?? [];
  const line = (row: string[]) =>
    row
      .map((cell, col) =>
        col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0),
      )
      .join('  ');
  const [head, ...body] = cells;
  return [
    line(head ?? []),
    widths.map((w) => '─'.repeat(w)).join('  '),
    ...body.map(line),
  ].join('\n');
}
