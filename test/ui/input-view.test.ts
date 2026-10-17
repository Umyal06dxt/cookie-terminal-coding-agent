import { describe, expect, test } from 'bun:test';
import {
  type EditorAction,
  editorReduce,
  emptyEditor,
} from '../../src/ui/editor.ts';
import {
  inputRows,
  MAX_INPUT_ROWS,
  pickerRows,
} from '../../src/ui/input-view.ts';
import { lineWidth } from '../../src/ui/lines.ts';
import { pickerFor } from '../../src/ui/picker.ts';
import { texts } from './helpers.ts';

const editor = (text: string, ...actions: EditorAction[]) =>
  actions.reduce(
    editorReduce,
    editorReduce(emptyEditor(), { type: 'insert', text }),
  );

describe('inputRows', () => {
  test('empty input shows the caret, a cursor cell and the placeholder', () => {
    const [row] = inputRows(emptyEditor(), 40, 'Ask cookie anything');
    expect(texts([row ?? []])).toEqual(['›  Ask cookie anything']);
    expect(row?.[1]).toEqual({ text: ' ', inverse: true });
  });

  test('the cursor is an inverted cell over the character it sits on', () => {
    const [row] = inputRows(editor('bake', { type: 'left' }), 40, '');
    expect(row?.find((s) => s.inverse)).toMatchObject({ text: 'e' });
    expect(texts(inputRows(editor('bake'), 40, ''))).toEqual(['› bake ']);
  });

  test('long lines scroll sideways to keep the cursor in view', () => {
    const rows = inputRows(editor('x'.repeat(100)), 30, '');
    expect(lineWidth(rows[0] ?? [])).toBeLessThanOrEqual(30);
    expect(rows[0]?.at(-1)).toMatchObject({ inverse: true });
  });

  test('multiline input grows to a cap, following the cursor', () => {
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const rows = texts(inputRows(editor(many), 40, ''));
    expect(rows).toHaveLength(MAX_INPUT_ROWS);
    expect(rows.at(-1)).toBe('  line 9 ');
  });
});

describe('pickerRows', () => {
  test('marks the selected entry', () => {
    const rows = texts(pickerRows(pickerFor('/', 1, []), 1, 40));
    expect(rows[1]).toStartWith(' › /clear');
    expect(rows[0]).toStartWith('   /help');
  });

  test('an empty file match says so', () => {
    expect(texts(pickerRows(pickerFor('@zz', 3, ['a.ts']), 0, 40))).toEqual([
      '   No files match "zz"',
    ]);
  });
});
