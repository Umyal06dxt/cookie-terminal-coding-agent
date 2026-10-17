import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { applyEdit, detectEol, toEol, toLf } from './edit-text.ts';
import { sniffBinary } from './file-type.ts';
import { checkFresh, recordWrite } from './ledger.ts';
import { resolveInRoot } from './paths.ts';
import { defineTool } from './types.ts';

export const editTool = defineTool({
  name: 'edit',
  kind: 'write',
  description:
    'Replace an exact string in a file you have read. old_string must match exactly once unless replace_all is true; include surrounding lines to make it unique. Line numbers from read are not part of the file.',
  schema: z.object({
    file_path: z
      .string()
      .describe('Path to the file, relative to the project root'),
    old_string: z.string().describe('Exact text to replace'),
    new_string: z.string().describe('Text to put in its place'),
    replace_all: z
      .boolean()
      .optional()
      .describe('Replace every occurrence. Default false'),
  }),
  async run(
    { file_path, old_string, new_string, replace_all = false },
    { projectRoot, readLedger },
  ) {
    const path = resolveInRoot(projectRoot, file_path);
    if (!path.ok) return path;

    let isFile = false;
    try {
      isFile = statSync(path.abs).isFile();
    } catch {
      // Falls through to the "no file" answer below.
    }
    if (!isFile) {
      return {
        ok: false,
        output: `There is no file at ${path.rel} to edit.`,
        hint: 'Use write to create a new file, or glob to find the right path.',
      };
    }
    if (old_string === '') {
      return {
        ok: false,
        output: 'old_string is empty, so there is nothing to find.',
        hint: 'Copy the exact lines to change into old_string, or use write for a whole new file.',
      };
    }
    if (old_string === new_string) {
      return {
        ok: false,
        output:
          'old_string and new_string are identical, so the edit would change nothing.',
      };
    }

    const stale = checkFresh(readLedger, path.abs, path.rel, {
      needFull: false,
      action: 'edited',
    });
    if (stale) return stale;

    const bytes = readFileSync(path.abs);
    let original: string;
    try {
      if (sniffBinary(bytes)) throw new Error('binary');
      original = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      return {
        ok: false,
        output: `${path.rel} is not UTF-8 text, so edit won't touch it (it could corrupt the file).`,
        hint: 'Use bash with a tool that understands the encoding, or ask the user.',
      };
    }
    // read shows lines without \r; match a CRLF file as LF, then write CRLF back.
    const eol = detectEol(original);
    const crlf = eol === '\r\n';
    const text = crlf ? toLf(original) : original;
    const outcome = applyEdit(
      text,
      toLf(old_string),
      toLf(new_string),
      replace_all,
    );

    if (outcome.kind === 'missing') {
      const near = outcome.similar
        .map((l) => `  line ${l.line}: ${l.text}`)
        .join('\n');
      return {
        ok: false,
        output: `old_string was not found in ${path.rel}.${near ? `\nThe most similar lines are:\n${near}` : ''}`,
        hint: 'Read the file again and copy the text exactly, including whitespace.',
      };
    }
    if (outcome.kind === 'ambiguous') {
      return {
        ok: false,
        output: `old_string appears ${outcome.count} times in ${path.rel}.`,
        hint: 'Include more surrounding lines so it matches exactly once, or set replace_all to true.',
      };
    }

    writeFileSync(path.abs, crlf ? toEol(outcome.text, eol) : outcome.text);
    recordWrite(readLedger, path.abs, readLedger.get(path.abs)?.full ?? false);
    const what =
      outcome.count === 1 ? '1 occurrence' : `${outcome.count} occurrences`;
    return {
      ok: true,
      output: `Edited ${path.rel}: replaced ${what}, starting at line ${outcome.firstLine}.`,
      summary: `replaced ${what}`,
    };
  },
});
