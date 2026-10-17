import type { Seg } from './lines.ts';

/** Keywords common to the languages people paste most: TS/JS, Python, Go, Rust, shell. */
const KEYWORDS = new Set(
  (
    'as async await break case catch class const continue def default defer del do elif else ' +
    'enum export extends false fi fn for from func function go if impl import in interface ' +
    'let match mod mut new nil None null package pass pub raise return self static struct ' +
    'super switch then this throw trait True true try type typeof undefined use var void while ' +
    'with yield False'
  ).split(' '),
);

const HASH_COMMENT = new Set([
  'py',
  'python',
  'sh',
  'bash',
  'zsh',
  'shell',
  'rb',
  'ruby',
  'toml',
  'yaml',
  'yml',
]);

/** Order matters: comments and strings first, so keywords inside them stay uncoloured. */
function tokenPattern(lang: string): RegExp {
  const comment = HASH_COMMENT.has(lang) ? '#.*' : '\\/\\/.*|#!.*';
  return new RegExp(
    `(?<comment>${comment})|(?<string>"(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`(?:[^\`\\\\]|\\\\.)*\`?)|(?<number>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)|(?<word>[A-Za-z_$][\\w$]*)`,
    'g',
  );
}

/**
 * Colours one line of code. Line-at-a-time on purpose: it streams, never re-lexes the whole block,
 * and a multi-line string or comment only loses colour, never text.
 */
export function highlightLine(line: string, lang = ''): Seg[] {
  const segs: Seg[] = [];
  const plain = (text: string) => {
    if (text !== '') segs.push({ text, fg: 'dough' });
  };
  let at = 0;
  for (const match of line.matchAll(tokenPattern(lang.toLowerCase()))) {
    const groups = match.groups ?? {};
    const text = match[0];
    const start = match.index;
    if (groups.word !== undefined && !KEYWORDS.has(text)) continue;
    plain(line.slice(at, start));
    if (groups.comment !== undefined)
      segs.push({ text, fg: 'chip', italic: true });
    else if (groups.string !== undefined) segs.push({ text, fg: 'matcha' });
    else if (groups.number !== undefined) segs.push({ text, fg: 'sprinkle' });
    else segs.push({ text, fg: 'crust' });
    at = start + text.length;
  }
  plain(line.slice(at));
  return segs;
}
