import { type Line, wrap } from './lines.ts';
import { renderMarkdown } from './markdown.ts';
import type { Item } from './state.ts';
import { toolCard } from './tool-card.ts';

const INDENT = '  ';

/** One item as terminal rows, at most `columns` wide. */
export function renderItem(item: Item, columns: number): Line[] {
  switch (item.kind) {
    case 'user':
      return item.text.split('\n').flatMap((line, i) =>
        wrap(
          [
            { text: i === 0 ? ' › ' : '   ', fg: 'crust', bold: true },
            { text: line, fg: 'dough', bold: true },
          ],
          columns,
          '   ',
        ),
      );
    case 'assistant':
      return renderMarkdown(item.text, columns, INDENT);
    case 'tool':
      return toolCard(item, columns);
    case 'notice':
      return wrap(
        [
          item.tone === 'error'
            ? { text: `${INDENT}✗ `, fg: 'jam' }
            : { text: `${INDENT}· `, fg: 'chip' },
          { text: item.text, fg: item.tone === 'error' ? 'jam' : 'chip' },
        ],
        columns,
        `${INDENT}  `,
      );
  }
}

/** Items only change by being replaced, so rows are cached per item object and width. */
const cache = new WeakMap<Item, { columns: number; rows: Line[] }>();

function rowsFor(item: Item, columns: number): Line[] {
  const hit = cache.get(item);
  if (hit && hit.columns === columns) return hit.rows;
  const rows = renderItem(item, columns);
  cache.set(item, { columns, rows });
  return rows;
}

/**
 * The whole transcript as rows. A blank row separates blocks, except between consecutive
 * tool cards, which stack like the design's card list.
 */
export function renderTranscript(
  items: readonly Item[],
  columns: number,
): Line[] {
  const rows: Line[] = [];
  let previous: Item | undefined;
  for (const item of items) {
    const stacked = previous?.kind === 'tool' && item.kind === 'tool';
    if (previous && !stacked) rows.push([]);
    rows.push(...rowsFor(item, columns));
    previous = item;
  }
  return rows;
}

/**
 * The rows that fit in `height`, `scroll` rows up from the bottom. Returns the rows and the
 * scroll actually applied (clamped).
 */
export function viewport(
  rows: readonly Line[],
  height: number,
  scroll = 0,
): { rows: Line[]; scroll: number } {
  const max = Math.max(0, rows.length - height);
  const applied = Math.min(Math.max(0, scroll), max);
  const end = rows.length - applied;
  return { rows: rows.slice(Math.max(0, end - height), end), scroll: applied };
}
