import { cursorPosition, type EditorState } from './editor.ts';
import { type Line, type Seg, truncate, width } from './lines.ts';
import { PICKER_ROWS, type Picker } from './picker.ts';

/** Rows the input box may grow to before it scrolls with the cursor. */
export const MAX_INPUT_ROWS = 6;

const CARET = '› ';

/**
 * The text inside the box, one row per input line (cut, not wrapped, so the cursor maths stay
 * simple), with the cursor drawn as an inverted cell. Shows at most MAX_INPUT_ROWS rows around
 * the cursor.
 */
export function inputRows(
  editor: EditorState,
  columns: number,
  placeholder: string,
): Line[] {
  const inner = Math.max(4, columns - width(CARET));
  if (editor.text === '') {
    return [
      [
        { text: CARET, fg: 'crust', bold: true },
        { text: ' ', inverse: true },
        { text: placeholder.slice(0, inner - 1), fg: 'chip' },
      ],
    ];
  }
  const lines = editor.text.split('\n');
  const { row, column } = cursorPosition(editor);
  const first = Math.max(
    0,
    Math.min(row - MAX_INPUT_ROWS + 1, lines.length - MAX_INPUT_ROWS),
  );
  return lines.slice(first, first + MAX_INPUT_ROWS).map((text, i) => {
    const lead: Seg = {
      text: first + i === 0 ? CARET : '  ',
      fg: 'crust',
      bold: true,
    };
    if (first + i !== row)
      return truncate([lead, { text, fg: 'dough' }], columns);
    return [lead, ...withCursor(text, column, inner)];
  });
}

/** The cursor's line, scrolled sideways so the cursor stays in view. */
function withCursor(text: string, column: number, inner: number): Seg[] {
  const before = text.slice(0, column);
  const at = [...text.slice(column)][0] ?? ' ';
  const after = text.slice(column + at.length);
  let shownBefore = before;
  while (width(shownBefore) > inner - 2)
    shownBefore = [...shownBefore].slice(1).join('');
  const room = Math.max(0, inner - width(shownBefore) - width(at));
  let shownAfter = '';
  for (const ch of after) {
    if (width(shownAfter + ch) > room) break;
    shownAfter += ch;
  }
  const segs: Seg[] = [
    { text: shownBefore, fg: 'dough' },
    { text: at, fg: 'dough', inverse: true },
    { text: shownAfter, fg: 'dough' },
  ];
  return segs.filter((s) => s.text !== '');
}

/** The open picker as rows under the box, highlighted entry first-class. */
export function pickerRows(
  picker: Picker,
  selected: number,
  columns: number,
): Line[] {
  if (picker.kind === 'command') {
    return picker.matches.slice(0, PICKER_ROWS).map((c, i) =>
      truncate(
        [
          { text: i === selected ? ' › ' : '   ', fg: 'crust' },
          {
            text: c.name.padEnd(10),
            fg: i === selected ? 'crust' : 'dough',
            bold: i === selected,
          },
          { text: c.description, fg: 'chip' },
        ],
        columns,
      ),
    );
  }
  if (picker.kind === 'file') {
    if (picker.matches.length === 0) {
      return [[{ text: `   No files match "${picker.query}"`, fg: 'chip' }]];
    }
    return picker.matches.map((path, i) =>
      truncate(
        [
          { text: i === selected ? ' › ' : '   ', fg: 'crust' },
          {
            text: path,
            fg: i === selected ? 'blueberry' : 'dough',
            bold: i === selected,
          },
        ],
        columns,
      ),
    );
  }
  return [];
}
