import { diffLines } from 'diff';
import { toolTarget } from '../headless/format.ts';
import { type Line, type Seg, truncate, width } from './lines.ts';
import type { Item } from './state.ts';

type ToolItem = Extract<Item, { kind: 'tool' }>;

/** Diff rows shown under an edit card before the rest is summarised. */
export const DIFF_ROWS = 12;

export interface EditDiff {
  added: number;
  removed: number;
  /** Changed lines only, in order: the "+"/"−" rows under the card. */
  rows: { sign: '+' | '-'; text: string }[];
}

/** The change an edit call asks for, from its arguments. Null when they aren't an edit's. */
export function editDiff(args: unknown): EditDiff | null {
  if (typeof args !== 'object' || args === null) return null;
  const { old_string, new_string } = args as Record<string, unknown>;
  if (typeof old_string !== 'string' || typeof new_string !== 'string')
    return null;
  const diff: EditDiff = { added: 0, removed: 0, rows: [] };
  for (const part of diffLines(old_string, new_string)) {
    if (!part.added && !part.removed) continue;
    const lines = part.value.replace(/\r?\n$/, '').split(/\r?\n/);
    for (const text of lines) {
      diff.rows.push({ sign: part.added ? '+' : '-', text });
      if (part.added) diff.added++;
      else diff.removed++;
    }
  }
  return diff;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Keeps the end of a path, which says more than its start: "…/routes/upload.ts". */
function clipStart(text: string, max: number): string {
  if (width(text) <= max) return text;
  if (max <= 1) return '…'.slice(0, max);
  const chars = [...text];
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = (chars[i] ?? '') + out;
    if (width(next) > max - 1) break;
    out = next;
  }
  return `…${out}`;
}

const NAME_WIDTH = 5;

/**
 * "  ▸ Read  src/db/schema.ts        118 lines  0.04s". Successful edits get "▾" and their
 * diff underneath; failures get "✗" in jam. Never wider than `columns`.
 */
export function toolCard(item: ToolItem, columns: number): Line[] {
  const diff =
    item.name === 'edit' && item.status !== 'failed'
      ? editDiff(item.args)
      : null;
  const icon: Seg =
    item.status === 'failed'
      ? { text: '✗', fg: 'jam' }
      : { text: diff ? '▾' : '▸', fg: 'crust' };
  const name = item.name.charAt(0).toUpperCase() + item.name.slice(1);

  const right: Seg[] = [];
  if (item.status === 'running') right.push({ text: '…', fg: 'chip' });
  else if (diff) {
    right.push({ text: `+${diff.added}`, fg: 'matcha' });
    right.push({ text: ` −${diff.removed}`, fg: 'jam' });
  } else if (item.summary !== '') {
    right.push({
      text: item.summary.split('\n', 1)[0] ?? '',
      fg: item.status === 'failed' ? 'jam' : 'chip',
    });
  }
  if (item.durationMs !== null) {
    right.push({ text: `  ${seconds(item.durationMs)}`, fg: 'chip' });
  }

  const head: Seg[] = [
    { text: '  ' },
    icon,
    { text: ` ${name.padEnd(NAME_WIDTH)} ` },
  ];
  const headWidth = head.reduce((n, s) => n + width(s.text), 0);
  const rightText = right.map((s) => s.text).join('');
  // The target shrinks first; the result and time only when the target is gone.
  const room = columns - headWidth - width(rightText) - 2;
  const target = toolTarget(item.args);
  const shown = room >= 4 ? clipStart(target, room) : '';
  const gap = Math.max(
    2,
    columns - headWidth - width(shown) - width(rightText),
  );
  const segs: Seg[] = [
    ...head,
    { text: shown, fg: 'blueberry' },
    { text: ' '.repeat(rightText === '' ? 0 : gap) },
    ...right,
  ];
  const card = truncate(
    segs.filter((s) => s.text !== ''),
    columns,
  );
  return [card, ...(diff ? diffRows(diff, columns) : [])];
}

function diffRows(diff: EditDiff, columns: number): Line[] {
  const rows = diff.rows.slice(0, DIFF_ROWS).map(
    (row): Line =>
      truncate(
        [
          { text: '     ' },
          {
            text: `${row.sign === '+' ? '+' : '−'} ${row.text.replaceAll('\t', '  ')}`,
            fg: row.sign === '+' ? 'matcha' : 'jam',
          },
        ],
        columns,
      ),
  );
  const hidden = diff.rows.length - DIFF_ROWS;
  if (hidden > 0) {
    rows.push([
      { text: '     ' } satisfies Seg,
      {
        text: `… ${hidden} more changed line${hidden === 1 ? '' : 's'}`,
        fg: 'chip',
      },
    ]);
  }
  return rows;
}
