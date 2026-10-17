import { describe, expect, test } from 'bun:test';
import { lineText, lineWidth, truncate, wrap } from '../../src/ui/lines.ts';
import { texts } from './helpers.ts';

describe('wrap', () => {
  test('breaks at spaces and indents continuation rows', () => {
    const rows = wrap([{ text: 'the quick brown fox jumps' }], 10, '  ');
    expect(texts(rows)).toEqual(['the quick', '  brown', '  fox', '  jumps']);
  });

  test('hard-breaks a word longer than the row', () => {
    expect(texts(wrap([{ text: 'abcdefghij' }], 4))).toEqual([
      'abcd',
      'efgh',
      'ij',
    ]);
  });

  test('keeps styles per segment and never exceeds the width', () => {
    const rows = wrap(
      [
        { text: 'plain ', fg: 'dough' },
        { text: 'bold words here', bold: true },
      ],
      8,
    );
    for (const row of rows) expect(lineWidth(row)).toBeLessThanOrEqual(8);
    expect(rows[0]?.[0]).toEqual({ text: 'plain', fg: 'dough' });
    expect(rows[1]?.[0]).toMatchObject({ bold: true });
  });

  test('counts wide characters as two cells', () => {
    const rows = wrap([{ text: '🍪🍪🍪' }], 4);
    expect(texts(rows)).toEqual(['🍪🍪', '🍪']);
  });

  test('tabs become two spaces', () => {
    expect(lineText(wrap([{ text: 'a\tb' }], 10)[0] ?? [])).toBe('a  b');
  });
});

describe('truncate', () => {
  test('ends with an ellipsis when it cuts', () => {
    const line = truncate(
      [{ text: 'hello ' }, { text: 'world', fg: 'crust' }],
      8,
    );
    expect(lineText(line)).toBe('hello w…');
    expect(lineWidth(line)).toBe(8);
  });

  test('leaves short lines alone', () => {
    const line = [{ text: 'hi' }];
    expect(truncate(line, 8)).toBe(line);
  });
});
