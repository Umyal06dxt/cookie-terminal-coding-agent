import { describe, expect, test } from 'bun:test';
import { editorReduce, emptyEditor } from '../../src/ui/editor.ts';
import { intentFor, type KeyContext, key } from '../../src/ui/keymap.ts';

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  editor: editorReduce(emptyEditor(), { type: 'insert', text: 'hi' }),
  pickerOpen: false,
  busy: false,
  page: 10,
  ...over,
});

describe('intentFor', () => {
  test('esc interrupts a running turn, closes a picker first, else does nothing', () => {
    expect(intentFor('', key({ escape: true }), ctx({ busy: true }))).toEqual({
      type: 'interrupt',
    });
    expect(
      intentFor(
        '',
        key({ escape: true }),
        ctx({ busy: true, pickerOpen: true }),
      ),
    ).toEqual({
      type: 'close-picker',
    });
    expect(intentFor('', key({ escape: true }), ctx())).toEqual({
      type: 'none',
    });
  });

  test('ctrl+c always goes to the exit guard', () => {
    expect(intentFor('c', key({ ctrl: true }), ctx({ busy: true }))).toEqual({
      type: 'ctrl-c',
    });
  });

  test('enter submits; shift/alt+enter and "\\"+enter add a line', () => {
    expect(intentFor('', key({ return: true }), ctx())).toEqual({
      type: 'submit',
    });
    expect(intentFor('', key({ return: true, shift: true }), ctx())).toEqual({
      type: 'edit',
      action: { type: 'newline' },
    });
    expect(intentFor('', key({ return: true, meta: true }), ctx()).type).toBe(
      'edit',
    );
    const slash = ctx({
      editor: editorReduce(emptyEditor(), { type: 'insert', text: 'a\\' }),
    });
    expect(intentFor('', key({ return: true }), slash)).toEqual({
      type: 'edits',
      actions: [{ type: 'backspace' }, { type: 'newline' }],
    });
  });

  test('with a picker open, arrows move, tab and enter pick', () => {
    const open = ctx({ pickerOpen: true });
    expect(intentFor('', key({ downArrow: true }), open)).toEqual({
      type: 'picker-move',
      by: 1,
    });
    expect(intentFor('', key({ upArrow: true }), open)).toEqual({
      type: 'picker-move',
      by: -1,
    });
    expect(intentFor('', key({ tab: true }), open)).toEqual({ type: 'pick' });
    expect(intentFor('', key({ return: true }), open)).toEqual({
      type: 'pick',
    });
  });

  test('without a picker, arrows edit and browse history', () => {
    expect(intentFor('', key({ upArrow: true }), ctx())).toEqual({
      type: 'edit',
      action: { type: 'up' },
    });
  });

  test('shift+tab toggles the oven mode; page keys scroll by a page', () => {
    expect(intentFor('', key({ tab: true, shift: true }), ctx())).toEqual({
      type: 'toggle-oven',
    });
    expect(intentFor('', key({ pageUp: true }), ctx())).toEqual({
      type: 'scroll',
      by: 10,
    });
    expect(intentFor('', key({ pageDown: true }), ctx())).toEqual({
      type: 'scroll',
      by: -10,
    });
  });

  test('typing inserts; other ctrl and meta chords do not', () => {
    expect(intentFor('x', key(), ctx())).toEqual({
      type: 'edit',
      action: { type: 'insert', text: 'x' },
    });
    expect(intentFor('pasted\ntext', key(), ctx()).type).toBe('edit');
    expect(intentFor('k', key({ ctrl: true }), ctx())).toEqual({
      type: 'none',
    });
    expect(intentFor('u', key({ ctrl: true }), ctx())).toEqual({
      type: 'edit',
      action: { type: 'clear' },
    });
    expect(intentFor('', key({ backspace: true }), ctx())).toEqual({
      type: 'edit',
      action: { type: 'backspace' },
    });
  });
});
