/**
 * Chip, the mascot, as 16×16 pixel art (docs/design.md, "The vibe"): a round golden cookie, a
 * bite out of the top-right with crumbs falling from it, a lighter rim catching the light on the
 * upper left, dark chocolate chips, and a small face. Pure data and a pure renderer: no Ink.
 */

/** One character per pixel. */
export const SPRITE: readonly string[] = [
  '..............k.',
  '.....oooooo.....',
  '...oorrrrro.....',
  '..orrbbbbbbo.k..',
  '..orcbbbbcbo...k',
  '.orbbbbbbbbboo..',
  '.orbbbbbbbbbbbo.',
  'orbbbebbbebbbbbo',
  'orbbbbbbbbbbcbbo',
  'orbbbbmbbmbbbbbo',
  '.orbbbbmmbbbbbo.',
  '.obcbbbbbbbbbbo.',
  '..obbbbbbbbcbo..',
  '..obbbbcbbbbbo..',
  '...oobbbbbboo...',
  '.....oooooo.....',
];

export type Pixel = 'o' | 'r' | 'b' | 'c' | 'e' | 'm' | 'k';

/** Baked edge, rim highlight, body, chips, face, crumbs. "." is transparent. */
export const PIXEL_COLOURS: Record<Pixel, string> = {
  o: '#A0673A', // brown butter: the baked edge
  r: '#F3C98B', // the rim catching the light
  b: '#E0A458', // golden crust
  c: '#4A2C20', // chocolate chips
  e: '#2A1A12', // eyes
  m: '#2A1A12', // mouth
  k: '#C98A45', // crumbs
};

/** The face only shows on the welcome screen and in idle moments. */
const FACE = new Set<string>(['e', 'm']);

export interface Cell {
  char: string;
  /** Hex colours; undefined is the terminal's own background. */
  fg?: string;
  bg?: string;
}

function pixel(
  row: string | undefined,
  x: number,
  face: boolean,
): Pixel | null {
  const ch = row?.[x];
  if (ch === undefined || ch === '.') return null;
  if (FACE.has(ch) && !face) return 'b';
  return ch as Pixel;
}

/**
 * Two pixel rows per terminal row with "▀" (top in fg, bottom in bg), so a 16×16 sprite is
 * 16 columns by 8 rows and its pixels come out square.
 */
export function halfBlocks(
  sprite: readonly string[] = SPRITE,
  { face = true }: { face?: boolean } = {},
): Cell[][] {
  const rows: Cell[][] = [];
  const width = Math.max(0, ...sprite.map((r) => r.length));
  for (let y = 0; y < sprite.length; y += 2) {
    const cells: Cell[] = [];
    for (let x = 0; x < width; x++) {
      const top = pixel(sprite[y], x, face);
      const bottom = pixel(sprite[y + 1], x, face);
      if (top && bottom) {
        cells.push({
          char: '▀',
          fg: PIXEL_COLOURS[top],
          bg: PIXEL_COLOURS[bottom],
        });
      } else if (top) {
        cells.push({ char: '▀', fg: PIXEL_COLOURS[top] });
      } else if (bottom) {
        cells.push({ char: '▄', fg: PIXEL_COLOURS[bottom] });
      } else {
        cells.push({ char: ' ' });
      }
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Without colour, half blocks can only say "dough or not": chips, the face and crumbs become
 * holes, which still reads as a bitten cookie.
 */
export function monochrome(sprite: readonly string[] = SPRITE): string[] {
  const solid = (row: string | undefined, x: number) => {
    const ch = row?.[x];
    return ch === 'o' || ch === 'r' || ch === 'b';
  };
  const rows: string[] = [];
  for (let y = 0; y < sprite.length; y += 2) {
    let line = '';
    for (let x = 0; x < (sprite[y]?.length ?? 0); x++) {
      const top = solid(sprite[y], x);
      const bottom = solid(sprite[y + 1], x);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    rows.push(line.trimEnd());
  }
  return rows;
}
