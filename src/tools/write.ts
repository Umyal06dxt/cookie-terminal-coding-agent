import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { detectEol, toEol, toLf } from './edit-text.ts';
import { checkFresh, recordWrite } from './ledger.ts';
import { resolveInRoot } from './paths.ts';
import { defineTool } from './types.ts';

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export const writeTool = defineTool({
  name: 'write',
  kind: 'write',
  description:
    'Create a file with the given content (parent folders are created). Overwriting an existing file requires reading all of it first; prefer edit for changes.',
  schema: z.object({
    file_path: z
      .string()
      .describe('Path to the file, relative to the project root'),
    content: z.string().describe('The complete file content'),
  }),
  async run({ file_path, content }, { projectRoot, readLedger }) {
    const path = resolveInRoot(projectRoot, file_path);
    if (!path.ok) return path;

    let exists = false;
    try {
      const stat = statSync(path.abs);
      if (stat.isDirectory()) {
        return {
          ok: false,
          output: `${path.rel} is a directory, so it can't be written as a file.`,
          hint: 'Choose a file path inside it.',
        };
      }
      exists = true;
    } catch {
      // A new file.
    }

    let body = content;
    if (exists) {
      const existing = readFileSync(path.abs, 'utf8');
      const existingLines = lineCount(toLf(existing));
      const stale = checkFresh(readLedger, path.abs, path.rel, {
        needFull: true,
        action: 'overwritten',
        // A plain read stops at 2000 lines, so name a limit that covers the whole file.
        fullReadHint: `Read ${path.rel} with offset 1 and limit ${Math.max(existingLines, 1)} (it has ${existingLines} lines), then try again.`,
      });
      if (stale) return stale;
      // Keep a CRLF file CRLF when the model wrote plain LF.
      const eol = detectEol(existing);
      if (eol === '\r\n' && !content.includes('\r\n'))
        body = toEol(content, eol);
    } else {
      mkdirSync(dirname(path.abs), { recursive: true });
    }

    writeFileSync(path.abs, body);
    recordWrite(readLedger, path.abs, true);
    const lines = lineCount(content);
    return {
      ok: true,
      output: `${exists ? 'Overwrote' : 'Created'} ${path.rel} (${lines} line${lines === 1 ? '' : 's'}).`,
    };
  },
});
