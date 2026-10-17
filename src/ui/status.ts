import { homedir } from 'node:os';
import { basename, sep } from 'node:path';
import { type Line, type Seg, truncate, width } from './lines.ts';
import { contextFraction, type UiState } from './state.ts';
import type { Token } from './theme.ts';

/** "~/projects/cookie" for paths under the home folder. */
export function displayFolder(path: string, home: string = homedir()): string {
  if (home !== '' && (path === home || path.startsWith(home + sep))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/** "▰▰▰▱▱" for `slots` cells. */
export function meter(fraction: number, slots = 5): string {
  const full = Math.round(Math.min(1, Math.max(0, fraction)) * slots);
  return '▰'.repeat(full) + '▱'.repeat(slots - full);
}

export function formatCost(usd: number): string {
  return usd < 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(1)}`;
}

/** Crumbs turn jam-red as the window gets tight. */
function meterColour(fraction: number): Token {
  if (fraction >= 0.85) return 'jam';
  if (fraction >= 0.6) return 'crust';
  return 'matcha';
}

const DOT: Seg = { text: ' · ', fg: 'butter' };

/**
 * " (•) cookie · model · ~/folder · branch      crumbs ▰▰▰▱▱ 41%  $0.38", fitted to
 * `columns`. Under pressure it drops, in order: the word "cookie", the folder's parents, the
 * meter's bar, then truncates the branch.
 */
export function statusLine(
  state: UiState,
  columns: number,
  glyph: string,
): Line {
  const { status, usage } = state;
  const fraction = contextFraction(state);

  const rightFor = (bar: boolean): Seg[] => {
    const segs: Seg[] = [];
    if (fraction !== null) {
      segs.push({ text: 'crumbs ', fg: 'chip' });
      if (bar)
        segs.push({ text: `${meter(fraction)} `, fg: meterColour(fraction) });
      segs.push({ text: `${Math.round(fraction * 100)}%`, fg: 'dough' });
    }
    if (usage.cost !== null) {
      if (segs.length > 0) segs.push({ text: '  ' });
      segs.push({ text: formatCost(usage.cost), fg: 'dough' });
    }
    if (segs.length > 0) segs.push({ text: ' ' });
    return segs;
  };

  const leftFor = (word: boolean, folder: string): Seg[] => {
    const segs: Seg[] = [{ text: ` ${glyph} `, fg: 'crust', bold: true }];
    if (word) segs.push({ text: 'cookie', fg: 'crust', bold: true }, DOT);
    segs.push({ text: status.model, fg: 'sprinkle' });
    segs.push(DOT, { text: folder, fg: 'blueberry' });
    if (status.branch !== '')
      segs.push(DOT, { text: status.branch, fg: 'dough' });
    return segs;
  };

  const short = basename(status.folder) || status.folder;
  const attempts: [boolean, string, boolean][] = [
    [true, status.folder, true],
    [false, status.folder, true],
    [false, short, true],
    [false, short, false],
  ];
  const segWidth = (segs: Seg[]) => segs.reduce((n, s) => n + width(s.text), 0);
  for (const [word, folder, bar] of attempts) {
    const left = leftFor(word, folder);
    const right = rightFor(bar);
    const gap = columns - segWidth(left) - segWidth(right);
    if (gap >= 2) return [...left, { text: ' '.repeat(gap) }, ...right];
  }
  // Still too wide: keep the numbers on the right, cut the left.
  const right = rightFor(false);
  const left = truncate(leftFor(false, short), columns - segWidth(right) - 1);
  const gap = Math.max(1, columns - segWidth(left) - segWidth(right));
  return truncate([...left, { text: ' '.repeat(gap) }, ...right], columns);
}
