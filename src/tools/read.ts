import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { sniffBinary } from './file-type.ts';
import { resolveInRoot } from './paths.ts';
import { defineTool } from './types.ts';

export const DEFAULT_READ_LIMIT = 2000;

/** Splits text into lines without their `\r\n` / `\n`; a trailing newline doesn't add a line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** `cat -n` layout: right-aligned 1-indexed number, a tab, the line. */
export function numberLines(
  lines: readonly string[],
  firstLine: number,
): string {
  return lines
    .map((line, i) => `${String(firstLine + i).padStart(6)}\t${line}`)
    .join('\n');
}

/** "1 line", "42 lines". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const readTool = defineTool({
  name: 'read',
  kind: 'read',
  description:
    'Read a text file. Lines come back numbered from 1 like `cat -n`. Reads up to 2000 lines; use offset and limit for more.',
  schema: z.object({
    file_path: z
      .string()
      .describe('Path to the file, relative to the project root'),
    offset: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('First line to read (1-indexed). Default 1'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `Maximum number of lines to read. Default ${DEFAULT_READ_LIMIT}`,
      ),
  }),
  async run(
    { file_path, offset = 1, limit = DEFAULT_READ_LIMIT },
    { projectRoot, readLedger },
  ) {
    const path = resolveInRoot(projectRoot, file_path);
    if (!path.ok) return path;

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path.abs);
    } catch {
      return {
        ok: false,
        output: `There is no file at ${path.rel}.`,
        hint: 'Check the spelling, or use glob to find the file.',
      };
    }
    if (stat.isDirectory()) {
      return {
        ok: false,
        output: `${path.rel} is a directory, not a file.`,
        hint: `Use glob with a pattern like "${path.rel}/*" to list it.`,
      };
    }

    const bytes = readFileSync(path.abs);
    const binary = sniffBinary(bytes);
    if (binary) {
      return {
        ok: false,
        output: `${path.rel} is a binary file (${binary}), so it can't be read as text.`,
      };
    }

    const lines = splitLines(new TextDecoder().decode(bytes));
    if (lines.length === 0) {
      readLedger.set(path.abs, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        full: true,
      });
      return { ok: true, output: 'The file is empty.', summary: '0 lines' };
    }
    if (offset > lines.length) {
      return {
        ok: false,
        output: `${path.rel} has ${lines.length} lines, so offset ${offset} is past the end.`,
        hint: `Use an offset between 1 and ${lines.length}.`,
      };
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const last = offset + slice.length - 1;
    const full = offset === 1 && last === lines.length;
    const previous = readLedger.get(path.abs);
    // Reading part of a file you already saw whole, unchanged, keeps it "fully read".
    const stillFull =
      previous?.full === true &&
      previous.mtimeMs === stat.mtimeMs &&
      previous.size === stat.size;
    readLedger.set(path.abs, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      full: full || stillFull,
    });

    let output = numberLines(slice, offset);
    if (!full) {
      const more =
        last < lines.length ? `; continue with offset=${last + 1}` : '';
      output += `\n\n(Showing lines ${offset}-${last} of ${lines.length}${more}.)`;
    }
    return { ok: true, output, summary: plural(slice.length, 'line') };
  },
});
