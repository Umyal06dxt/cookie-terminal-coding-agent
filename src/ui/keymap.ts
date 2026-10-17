import { type EditorAction, type EditorState, enterAction } from './editor.ts';

/** The subset of Ink's Key the UI reads; tests build it with `key()`. */
export interface KeyInfo {
  upArrow: boolean;
  downArrow: boolean;
  leftArrow: boolean;
  rightArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
  home: boolean;
  end: boolean;
  return: boolean;
  escape: boolean;
  ctrl: boolean;
  shift: boolean;
  tab: boolean;
  backspace: boolean;
  delete: boolean;
  meta: boolean;
}

export function key(pressed: Partial<KeyInfo> = {}): KeyInfo {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...pressed,
  };
}

export type Intent =
  | { type: 'edit'; action: EditorAction }
  /** Several edits in order, e.g. "\" + Enter: drop the backslash, add a line. */
  | { type: 'edits'; actions: EditorAction[] }
  | { type: 'submit' }
  | { type: 'pick' }
  | { type: 'picker-move'; by: 1 | -1 }
  | { type: 'close-picker' }
  | { type: 'interrupt' }
  | { type: 'ctrl-c' }
  | { type: 'toggle-oven' }
  | { type: 'scroll'; by: number }
  | { type: 'none' };

export interface KeyContext {
  editor: EditorState;
  pickerOpen: boolean;
  busy: boolean;
  /** Transcript rows per page, for PageUp/PageDown. */
  page: number;
}

/** What a keypress means right now. Pure: the app carries the intent out. */
export function intentFor(input: string, k: KeyInfo, ctx: KeyContext): Intent {
  if (k.ctrl && input === 'c') return { type: 'ctrl-c' };
  if (k.escape) {
    if (ctx.pickerOpen) return { type: 'close-picker' };
    return ctx.busy ? { type: 'interrupt' } : { type: 'none' };
  }
  if (k.tab && k.shift) return { type: 'toggle-oven' };
  if (ctx.pickerOpen) {
    if (k.upArrow) return { type: 'picker-move', by: -1 };
    if (k.downArrow) return { type: 'picker-move', by: 1 };
    if (k.tab || (k.return && !k.shift && !k.meta)) return { type: 'pick' };
  }
  if (k.return) {
    const what = enterAction(ctx.editor, k);
    if (what === 'submit') return { type: 'submit' };
    if (what === 'newline')
      return { type: 'edit', action: { type: 'newline' } };
    return {
      type: 'edits',
      actions: [{ type: 'backspace' }, { type: 'newline' }],
    };
  }
  if (k.pageUp) return { type: 'scroll', by: ctx.page };
  if (k.pageDown) return { type: 'scroll', by: -ctx.page };
  const action = editorKey(input, k);
  return action ? { type: 'edit', action } : { type: 'none' };
}

function editorKey(input: string, k: KeyInfo): EditorAction | null {
  if (k.upArrow) return { type: 'up' };
  if (k.downArrow) return { type: 'down' };
  if (k.leftArrow) return { type: 'left' };
  if (k.rightArrow) return { type: 'right' };
  if (k.home || (k.ctrl && input === 'a')) return { type: 'home' };
  if (k.end || (k.ctrl && input === 'e')) return { type: 'end' };
  if (k.backspace) return { type: 'backspace' };
  if (k.delete || (k.ctrl && input === 'd')) return { type: 'delete' };
  if (k.ctrl && input === 'u') return { type: 'clear' };
  if (k.ctrl || k.meta || k.tab || input === '') return null;
  return { type: 'insert', text: input };
}
