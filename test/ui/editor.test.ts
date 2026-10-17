import { describe, expect, test } from 'bun:test';
import {
  cursorPosition,
  type EditorAction,
  type EditorState,
  editorReduce,
  emptyEditor,
  enterAction,
  HISTORY_LIMIT,
  submitEditor,
} from '../../src/ui/editor.ts';

const apply = (state: EditorState, ...actions: EditorAction[]) =>
  actions.reduce(editorReduce, state);
const typed = (text: string, history: string[] = []) =>
  editorReduce(emptyEditor(history), { type: 'insert', text });

describe('editor', () => {
  test('typing, moving and deleting', () => {
    const s = apply(
      typed('helo'),
      { type: 'left' },
      { type: 'insert', text: 'l' },
    );
    expect(s).toMatchObject({ text: 'hello', cursor: 4 });
    expect(apply(s, { type: 'backspace' })).toMatchObject({
      text: 'helo',
      cursor: 3,
    });
    expect(apply(s, { type: 'delete' })).toMatchObject({
      text: 'hell',
      cursor: 4,
    });
    expect(apply(s, { type: 'home' }, { type: 'backspace' }).text).toBe(
      'hello',
    );
    expect(apply(s, { type: 'end' }, { type: 'delete' }).cursor).toBe(5);
  });

  test('multiline: newline, home/end per line, up/down keep the column', () => {
    const s = apply(
      typed('first'),
      { type: 'newline' },
      { type: 'insert', text: 'second line' },
    );
    expect(s.text).toBe('first\nsecond line');
    expect(cursorPosition(s)).toEqual({ row: 1, column: 11 });
    const up = apply(s, { type: 'up' });
    expect(cursorPosition(up)).toEqual({ row: 0, column: 5 });
    const home = apply(s, { type: 'home' });
    expect(cursorPosition(home)).toEqual({ row: 1, column: 0 });
    expect(
      cursorPosition(
        apply(home, { type: 'up' }, { type: 'right' }, { type: 'down' }),
      ),
    ).toEqual({
      row: 1,
      column: 1,
    });
  });

  test('history: up on the first line recalls, down returns to the draft', () => {
    const s = typed('draft', ['one', 'two']);
    const back1 = apply(s, { type: 'up' });
    expect(back1).toMatchObject({ text: 'two', browsing: 1 });
    const back2 = apply(back1, { type: 'up' }, { type: 'up' });
    expect(back2).toMatchObject({ text: 'one', browsing: 0 });
    const forward = apply(back2, { type: 'down' }, { type: 'down' });
    expect(forward).toMatchObject({ text: 'draft', browsing: null });
  });

  test('editing a recalled entry stops browsing', () => {
    const s = apply(
      typed('', ['one']),
      { type: 'up' },
      { type: 'insert', text: '!' },
    );
    expect(s).toMatchObject({ text: 'one!', browsing: null });
    expect(apply(s, { type: 'down' }).text).toBe('one!');
  });

  test('submit trims, records history once, and skips blanks', () => {
    const { text, next } = submitEditor(typed('  bake it  ', ['bake it']));
    expect(text).toBe('bake it');
    expect(next.history).toEqual(['bake it']);
    expect(next.text).toBe('');
    expect(submitEditor(typed('   ')).text).toBe('');
    const many = Array.from({ length: HISTORY_LIMIT }, (_, i) => `m${i}`);
    expect(submitEditor(typed('new', many)).next.history).toHaveLength(
      HISTORY_LIMIT,
    );
  });

  test('pasted CRLF becomes LF', () => {
    expect(typed('a\r\nb\rc').text).toBe('a\nb\nc');
  });

  test('the cursor steps over emoji as one character', () => {
    const s = typed('a🍪b');
    expect(apply(s, { type: 'left' }, { type: 'left' }).cursor).toBe(1);
    expect(apply(s, { type: 'left' }, { type: 'backspace' }).text).toBe('ab');
    expect(
      apply(s, { type: 'home' }, { type: 'right' }, { type: 'delete' }).text,
    ).toBe('ab');
  });

  test('clear and set', () => {
    expect(apply(typed('x'), { type: 'clear' })).toMatchObject({
      text: '',
      cursor: 0,
    });
    expect(
      apply(typed('x'), { type: 'set', text: '@a.ts tail', cursor: 6 }),
    ).toMatchObject({
      text: '@a.ts tail',
      cursor: 6,
    });
  });
});

describe('enterAction', () => {
  test('plain enter submits', () => {
    expect(enterAction(typed('go'), { shift: false, meta: false })).toBe(
      'submit',
    );
  });

  test('shift+enter (kitty protocol) and alt+enter add a line', () => {
    expect(enterAction(typed('go'), { shift: true, meta: false })).toBe(
      'newline',
    );
    expect(enterAction(typed('go'), { shift: false, meta: true })).toBe(
      'newline',
    );
  });

  test('a trailing backslash continues the line on any terminal', () => {
    expect(enterAction(typed('go \\'), { shift: false, meta: false })).toBe(
      'continue-line',
    );
  });
});
