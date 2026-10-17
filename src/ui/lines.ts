import type { Token } from './theme.ts';

/** A run of text with one style. Colours are palette tokens; the theme resolves them. */
export interface Seg {
  text: string;
  fg?: Token;
  bg?: Token;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
}

/** One terminal row. Never wider than the width it was wrapped to. */
export type Line = Seg[];

const TAB = '  ';

export function width(text: string): number {
  return Bun.stringWidth(text);
}

export function lineWidth(line: Line): number {
  return line.reduce((n, s) => n + width(s.text), 0);
}

export function lineText(line: Line): string {
  return line.map((s) => s.text).join('');
}

/** Splits a string into grapheme-ish units (code points; good enough for terminal cells). */
function chars(text: string): string[] {
  return [...text];
}

/**
 * Wraps one logical line (no "\n") of styled text to `max` cells. Breaks at the last space when it can, mid-word when a
 * word is longer than the line. `indent` is prepended to every continuation row.
 */
export function wrap(segs: readonly Seg[], max: number, indent = ''): Line[] {
  const limit = Math.max(1, max);
  const rows: Line[] = [];
  let row: Line = [];
  let used = 0;

  const push = (seg: Seg, text: string) => {
    if (text === '') return;
    const last = row.at(-1);
    if (last && sameStyle(last, seg)) last.text += text;
    else row.push({ ...seg, text });
    used += width(text);
  };
  const breakRow = () => {
    rows.push(trimEnd(row));
    row = indent === '' ? [] : [{ text: indent }];
    used = width(indent);
  };

  for (const seg of segs) {
    const text = seg.text.replaceAll('\t', TAB);
    // Split into words and the spaces after them, so breaks fall on spaces.
    for (const token of text.match(/\S+\s*|\s+/g) ?? []) {
      const word = token.trimEnd();
      const wordWidth = width(word);
      if (used > width(indent) && used + wordWidth > limit) breakRow();
      if (wordWidth <= limit - used) {
        // Trailing spaces may overhang; trimEnd drops them when the row breaks.
        push(seg, token);
        continue;
      }
      // Longer than a whole row: hard-break it.
      let piece = '';
      for (const ch of chars(token)) {
        if (used + width(piece) + width(ch) > limit) {
          push(seg, piece);
          piece = '';
          breakRow();
        }
        piece += ch;
      }
      push(seg, piece);
    }
  }
  rows.push(trimEnd(row));
  return rows;
}

function sameStyle(a: Seg, b: Seg): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.dim === b.dim
  );
}

function trimEnd(line: Line): Line {
  const out = line.map((s) => ({ ...s }));
  while (out.length > 0) {
    const last = out.at(-1);
    if (!last) break;
    last.text = last.text.trimEnd();
    if (last.text !== '' || last.bg !== undefined) break;
    out.pop();
  }
  return out;
}

/** Cuts a line to `max` cells, ending in "…" when anything was dropped. */
export function truncate(line: Line, max: number): Line {
  if (lineWidth(line) <= max) return line;
  const out: Line = [];
  let used = 0;
  for (const seg of line) {
    let text = '';
    for (const ch of chars(seg.text)) {
      if (used + width(ch) > max - 1) break;
      text += ch;
      used += width(ch);
    }
    if (text !== '') out.push({ ...seg, text });
    if (used >= max - 1 || text.length < seg.text.length) break;
  }
  out.push({ text: '…', fg: 'chip' });
  return out;
}
