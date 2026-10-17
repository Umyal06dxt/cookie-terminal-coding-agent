import { describe, expect, test } from 'bun:test';
import { lineText, lineWidth } from '../../src/ui/lines.ts';
import type { Item } from '../../src/ui/state.ts';
import { DIFF_ROWS, editDiff, toolCard } from '../../src/ui/tool-card.ts';
import { texts } from './helpers.ts';

type ToolItem = Extract<Item, { kind: 'tool' }>;

const card = (over: Partial<ToolItem>): ToolItem => ({
  kind: 'tool',
  key: 'k',
  id: 'c1',
  name: 'read',
  args: { file_path: 'packages/db/schema.ts' },
  status: 'ok',
  summary: '118 lines',
  durationMs: 40,
  ...over,
});

describe('toolCard', () => {
  test('one line: tool, target, size, time, filling the width', () => {
    const [row, ...rest] = toolCard(card({}), 60);
    expect(rest).toEqual([]);
    expect(lineText(row ?? [])).toBe(
      '  ▸ Read  packages/db/schema.ts             118 lines  0.04s',
    );
    expect(lineWidth(row ?? [])).toBe(60);
    expect(row?.find((s) => s.text === 'packages/db/schema.ts')).toMatchObject({
      fg: 'blueberry',
    });
  });

  test('a running call shows an ellipsis and no time', () => {
    const [row] = toolCard(
      card({ status: 'running', summary: '', durationMs: null }),
      40,
    );
    expect(lineText(row ?? [])).toMatch(
      /^ {2}▸ Read {2}packages\/db\/schema\.ts +…$/,
    );
  });

  test('a failure is marked in jam', () => {
    const [row] = toolCard(
      card({ status: 'failed', summary: 'no such file' }),
      60,
    );
    expect(row?.[1]).toEqual({ text: '✗', fg: 'jam' });
    expect(row?.find((s) => s.text === 'no such file')).toMatchObject({
      fg: 'jam',
    });
  });

  test('a long path keeps its end; the result and time never get cut first', () => {
    const [row] = toolCard(
      card({
        args: {
          file_path: 'apps/web/src/features/settings/storage/QuotaBar.tsx',
        },
      }),
      50,
    );
    const text = lineText(row ?? []);
    expect(lineWidth(row ?? [])).toBeLessThanOrEqual(50);
    expect(text).toContain('…');
    expect(text).toContain('QuotaBar.tsx');
    expect(text).toEndWith('118 lines  0.04s');
  });

  test('bash shows the command', () => {
    const [row] = toolCard(
      card({ name: 'bash', args: { command: 'bun test' }, summary: 'exit 0' }),
      50,
    );
    expect(lineText(row ?? [])).toStartWith('  ▸ Bash  bun test');
  });

  test('edits expand into their diff with +/− counts', () => {
    const rows = toolCard(
      card({
        name: 'edit',
        args: {
          file_path: 'apps/api/routes/upload.ts',
          old_string: 'const a = 1;\nkeep();\nold();',
          new_string: 'const a = 1;\nkeep();\nnewer();\nnewest();',
        },
        summary: 'replaced 1 occurrence',
      }),
      60,
    );
    expect(texts(rows)).toEqual([
      '  ▾ Edit  apps/api/routes/upload.ts             +2 −1  0.04s',
      '     − old();',
      '     + newer();',
      '     + newest();',
    ]);
    expect(rows[1]?.[1]).toMatchObject({ fg: 'jam' });
    expect(rows[2]?.[1]).toMatchObject({ fg: 'matcha' });
  });

  test('a failed edit shows no diff: nothing was applied', () => {
    const rows = toolCard(
      card({
        name: 'edit',
        status: 'failed',
        args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' },
        summary: 'no match',
      }),
      60,
    );
    expect(rows).toHaveLength(1);
  });

  test('long diffs are capped with a count', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const rows = toolCard(
      card({
        name: 'edit',
        args: { file_path: 'a.ts', old_string: '', new_string: many },
      }),
      60,
    );
    expect(rows).toHaveLength(1 + DIFF_ROWS + 1);
    expect(lineText(rows.at(-1) ?? [])).toBe('     … 8 more changed lines');
  });

  test('every row fits at 80 and at 20 columns', () => {
    const item = card({
      name: 'edit',
      args: {
        file_path: 'x/'.repeat(40),
        old_string: 'a',
        new_string: 'b'.repeat(200),
      },
    });
    for (const columns of [80, 20]) {
      for (const row of toolCard(item, columns))
        expect(lineWidth(row)).toBeLessThanOrEqual(columns);
    }
  });
});

describe('editDiff', () => {
  test('ignores args that are not an edit', () => {
    expect(editDiff('raw')).toBeNull();
    expect(editDiff({ file_path: 'a' })).toBeNull();
  });

  test('CRLF strings count lines like LF', () => {
    expect(
      editDiff({ old_string: 'a\r\nb\r\n', new_string: 'a\r\nc\r\n' }),
    ).toEqual({
      added: 1,
      removed: 1,
      rows: [
        { sign: '-', text: 'b' },
        { sign: '+', text: 'c' },
      ],
    });
  });
});
