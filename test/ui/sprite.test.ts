import { describe, expect, test } from 'bun:test';
import {
  halfBlocks,
  monochrome,
  PIXEL_COLOURS,
  SPRITE,
} from '../../src/ui/chip/sprite.ts';

const at = (x: number, y: number) => SPRITE[y]?.[x];

describe('Chip sprite', () => {
  test('is 16×16 and uses only known pixels', () => {
    expect(SPRITE).toHaveLength(16);
    for (const row of SPRITE) {
      expect(row).toHaveLength(16);
      for (const ch of row)
        expect(ch === '.' || ch in PIXEL_COLOURS).toBe(true);
    }
  });

  test('round body: symmetric extent on the left, solid centre', () => {
    expect(at(0, 7)).toBe('o');
    expect(at(0, 9)).toBe('o');
    expect(at(0, 2)).toBe('.');
    expect(at(0, 14)).toBe('.');
    expect(at(7, 8)).toBe('b');
  });

  test('the bite is out of the top-right, with crumbs beside it', () => {
    // Mirror pixels: top-left is dough, top-right is bitten away.
    expect(at(3, 2)).toBe('o');
    expect(at(12, 2)).toBe('.');
    expect(at(13, 3)).toBe('k');
    // The bottom-right is whole.
    expect(at(13, 12)).toBe('o');
  });

  test('rim highlight on the upper left, chips and a face', () => {
    expect(at(1, 7)).toBe('r');
    expect(SPRITE.join('').match(/c/g)?.length).toBeGreaterThanOrEqual(5);
    expect(SPRITE.join('').match(/e/g)).toHaveLength(2);
    expect(SPRITE.join('')).toContain('m');
  });

  test('half blocks: 8 rows of 16 cells, top pixel in fg, bottom in bg', () => {
    const rows = halfBlocks();
    expect(rows).toHaveLength(8);
    for (const row of rows) expect(row).toHaveLength(16);
    // Rows 6 and 7, column 0: transparent above, edge below.
    expect(rows[3]?.[0]).toEqual({ char: '▄', fg: PIXEL_COLOURS.o });
    // Rows 8 and 9, column 7: body over body.
    expect(rows[4]?.[7]).toEqual({
      char: '▀',
      fg: PIXEL_COLOURS.b,
      bg: PIXEL_COLOURS.b,
    });
    expect(rows[0]?.[0]).toEqual({ char: ' ' });
  });

  test('the face can be hidden (it only shows on welcome and idle)', () => {
    const colours = halfBlocks(SPRITE, { face: false })
      .flat()
      .flatMap((c) => [c.fg, c.bg]);
    expect(colours).not.toContain(PIXEL_COLOURS.e);
    expect(
      halfBlocks()
        .flat()
        .flatMap((c) => [c.fg, c.bg]),
    ).toContain(PIXEL_COLOURS.e);
  });

  test('monochrome fallback keeps the silhouette with chips as holes', () => {
    const rows = monochrome();
    expect(rows).toHaveLength(8);
    expect(rows.join('')).toMatch(/^[ █▀▄]+$/);
    expect(rows[3]).toStartWith('▄');
  });
});
