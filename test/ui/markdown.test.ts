import { describe, expect, test } from 'bun:test';
import { highlightLine } from '../../src/ui/highlight.ts';
import { inline, renderMarkdown } from '../../src/ui/markdown.ts';
import { texts, widest } from './helpers.ts';

describe('inline', () => {
  test('bold and code spans', () => {
    expect(inline('run `bun test` **now**')).toEqual([
      { text: 'run ' },
      { text: 'bun test', fg: 'crust' },
      { text: ' ' },
      { text: 'now', bold: true },
    ]);
  });

  test('unclosed markers mid-stream stay literal', () => {
    expect(inline('half **bold')).toEqual([{ text: 'half **bold' }]);
    expect(inline('a `tick')).toEqual([{ text: 'a `tick' }]);
  });
});

describe('renderMarkdown', () => {
  test('paragraphs, headings and lists', () => {
    const rows = renderMarkdown('# Plan\n\n- one\n- two\n1. first', 40, '  ');
    expect(texts(rows)).toEqual([
      '  Plan',
      '',
      '  • one',
      '  • two',
      '  1. first',
    ]);
    expect(rows[0]?.[1]).toMatchObject({ fg: 'crust', bold: true });
  });

  test('list items wrap under their text, not the bullet', () => {
    const rows = renderMarkdown('- alpha beta gamma delta', 14, '  ');
    expect(texts(rows)).toEqual(['  • alpha beta', '    gamma', '    delta']);
  });

  test('fenced code gets a bar and syntax colour; fences are hidden', () => {
    const rows = renderMarkdown(
      '```ts\nconst n = 42; // answer\n```\nafter',
      60,
      '  ',
    );
    expect(texts(rows)).toEqual(['  ▏ const n = 42; // answer', '  after']);
    const code = rows[0] ?? [];
    expect(code.find((s) => s.text === 'const')).toMatchObject({ fg: 'crust' });
    expect(code.find((s) => s.text === '42')).toMatchObject({ fg: 'sprinkle' });
    expect(code.find((s) => s.text === '// answer')).toMatchObject({
      fg: 'chip',
    });
  });

  test('an unclosed fence (still streaming) renders as code', () => {
    const rows = renderMarkdown('look:\n```py\nreturn "x"', 40);
    expect(texts(rows)).toEqual(['look:', '▏ return "x"']);
  });

  test('long code lines wrap with the bar on every row', () => {
    const rows = renderMarkdown('```\naaaa bbbb cccc dddd\n```', 12, '  ');
    expect(widest(rows)).toBeLessThanOrEqual(12);
    for (const row of texts(rows)) expect(row).toStartWith('  ▏ ');
    expect(rows[1]?.find((s) => s.text === '▏ ')).toMatchObject({
      fg: 'butter',
    });
  });

  test('CRLF text renders without carriage returns', () => {
    expect(texts(renderMarkdown('a\r\nb', 10))).toEqual(['a', 'b']);
  });
});

describe('highlightLine', () => {
  test('keywords inside strings and comments stay uncoloured', () => {
    const segs = highlightLine('return "if not" # for', 'py');
    expect(segs.map((s) => [s.text, s.fg])).toEqual([
      ['return', 'crust'],
      [' ', 'dough'],
      ['"if not"', 'matcha'],
      [' ', 'dough'],
      ['# for', 'chip'],
    ]);
  });

  test('loses no text', () => {
    const line = "let x = f('a\\'b', 3.5) // ok";
    expect(
      highlightLine(line, 'ts')
        .map((s) => s.text)
        .join(''),
    ).toBe(line);
  });
});
