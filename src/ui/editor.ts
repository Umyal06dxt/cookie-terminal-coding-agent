/**
 * The input box as pure data: multiline text, a cursor (a code-unit offset into `text`), and
 * history. Every key maps to an `EditorAction`; the Ink layer only translates keys.
 */
export interface EditorState {
  text: string;
  cursor: number;
  /** Oldest first. */
  history: readonly string[];
  /** Index into history while browsing it; null when editing a fresh line. */
  browsing: number | null;
  /** What was being typed before browsing started, restored when browsing past the newest. */
  draft: string;
}

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'up' }
  | { type: 'down' }
  /** Ctrl+U: clear the whole input. */
  | { type: 'clear' }
  /** Replace the text; the cursor goes to `cursor`, or the end (used by the pickers). */
  | { type: 'set'; text: string; cursor?: number };

export const HISTORY_LIMIT = 200;

export function emptyEditor(history: readonly string[] = []): EditorState {
  return { text: '', cursor: 0, history, browsing: null, draft: '' };
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function lineEnd(text: string, at: number): number {
  const end = text.indexOf('\n', at);
  return end === -1 ? text.length : end;
}

/** Steps over a whole surrogate pair, so the cursor never splits an emoji. */
function step(text: string, at: number, dir: 1 | -1): number {
  const isLow = (i: number) => {
    const code = text.charCodeAt(i);
    return code >= 0xdc00 && code <= 0xdfff;
  };
  if (dir === 1) {
    if (at >= text.length) return text.length;
    return at + (isLow(at + 1) ? 2 : 1);
  }
  if (at <= 0) return 0;
  return at - (isLow(at - 1) && at >= 2 ? 2 : 1);
}

function edit(state: EditorState, text: string, cursor: number): EditorState {
  return { ...state, text, cursor, browsing: null };
}

function recall(state: EditorState, index: number | null): EditorState {
  const text = index === null ? state.draft : (state.history[index] ?? '');
  return { ...state, text, cursor: text.length, browsing: index };
}

export function editorReduce(
  state: EditorState,
  action: EditorAction,
): EditorState {
  const { text, cursor } = state;
  switch (action.type) {
    case 'insert': {
      // Pasted text may carry CRLF; the box always holds LF.
      const clean = action.text.replace(/\r\n?/g, '\n');
      return edit(
        state,
        text.slice(0, cursor) + clean + text.slice(cursor),
        cursor + clean.length,
      );
    }
    case 'newline':
      return editorReduce(state, { type: 'insert', text: '\n' });
    case 'backspace': {
      if (cursor === 0) return state;
      const from = step(text, cursor, -1);
      return edit(state, text.slice(0, from) + text.slice(cursor), from);
    }
    case 'delete': {
      if (cursor === text.length) return state;
      const to = step(text, cursor, 1);
      return edit(state, text.slice(0, cursor) + text.slice(to), cursor);
    }
    case 'left':
      return { ...state, cursor: step(text, cursor, -1) };
    case 'right':
      return { ...state, cursor: step(text, cursor, 1) };
    case 'home':
      return { ...state, cursor: lineStart(text, cursor) };
    case 'end':
      return { ...state, cursor: lineEnd(text, cursor) };
    case 'up': {
      const start = lineStart(text, cursor);
      if (start > 0) {
        // Move up a line inside a multiline message, keeping the column where it fits.
        const prevStart = lineStart(text, start - 1);
        const column = Math.min(cursor - start, start - 1 - prevStart);
        return { ...state, cursor: prevStart + column };
      }
      if (state.history.length === 0) return state;
      const index =
        state.browsing === null
          ? state.history.length - 1
          : Math.max(0, state.browsing - 1);
      const draft = state.browsing === null ? text : state.draft;
      return recall({ ...state, draft }, index);
    }
    case 'down': {
      const end = lineEnd(text, cursor);
      if (end < text.length) {
        const start = lineStart(text, cursor);
        const nextEnd = lineEnd(text, end + 1);
        const column = Math.min(cursor - start, nextEnd - (end + 1));
        return { ...state, cursor: end + 1 + column };
      }
      if (state.browsing === null) return state;
      const next = state.browsing + 1;
      return recall(state, next >= state.history.length ? null : next);
    }
    case 'clear':
      return edit(state, '', 0);
    case 'set':
      return edit(
        state,
        action.text,
        Math.min(action.cursor ?? action.text.length, action.text.length),
      );
  }
}

/** Takes the text out for sending and records it in history (no blank or repeated entries). */
export function submitEditor(state: EditorState): {
  text: string;
  next: EditorState;
} {
  const text = state.text.trim();
  if (text === '') return { text: '', next: state };
  const history =
    state.history.at(-1) === text
      ? state.history
      : [...state.history, text].slice(-HISTORY_LIMIT);
  return { text, next: emptyEditor(history) };
}

/**
 * Enter sends, unless it should add a line instead: Shift+Enter (terminals with the kitty
 * keyboard protocol), Alt+Enter (most others), or a line ending in "\" (works everywhere).
 */
export function enterAction(
  state: EditorState,
  key: { shift: boolean; meta: boolean },
): 'submit' | 'newline' | 'continue-line' {
  if (key.shift || key.meta) return 'newline';
  if (state.text.slice(0, state.cursor).endsWith('\\')) return 'continue-line';
  return 'submit';
}

/** Rows of the input text, and the row and column the cursor is on. */
export function cursorPosition(state: EditorState): {
  row: number;
  column: number;
} {
  const before = state.text.slice(0, state.cursor).split('\n');
  return { row: before.length - 1, column: (before.at(-1) ?? '').length };
}
