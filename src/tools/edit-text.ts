/** Pure text helpers for the edit and write tools. */

export type Eol = '\n' | '\r\n';

/** The file's dominant line ending; LF when there are none. */
export function detectEol(text: string): Eol {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export const toLf = (text: string): string => text.replace(/\r\n/g, '\n');

export const toEol = (text: string, eol: Eol): string =>
  eol === '\n' ? text : toLf(text).replace(/\n/g, eol);

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    count++;
  }
  return count;
}

/** Character-bigram (Dice) similarity in [0, 1]; cheap and good enough to spot near-misses. */
export function similarity(a: string, b: string): number {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      shared++;
      grams.set(g, n - 1);
    }
  }
  return (2 * shared) / (x.length - 1 + (y.length - 1));
}

export interface SimilarLine {
  line: number;
  text: string;
}

/** The `count` lines most like the first non-blank line of `needle`, best first. */
export function mostSimilarLines(
  text: string,
  needle: string,
  count = 3,
): SimilarLine[] {
  const probe = needle.split('\n').find((l) => l.trim() !== '') ?? needle;
  return text
    .split('\n')
    .map((t, i) => ({
      line: i + 1,
      text: t,
      score: similarity(t.slice(0, 500), probe.slice(0, 500)),
    }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, count)
    .map(({ line, text: t }) => ({ line, text: t }));
}

export type EditOutcome =
  | { kind: 'ok'; text: string; count: number; firstLine: number }
  | { kind: 'missing'; similar: SimilarLine[] }
  | { kind: 'ambiguous'; count: number };

/**
 * Replaces `oldString` with `newString` in LF-normalised text. Never uses String.replace with a
 * string replacement, so `$&` or `$1` in the new text stay literal.
 */
export function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditOutcome {
  const count = countOccurrences(text, oldString);
  if (count === 0)
    return { kind: 'missing', similar: mostSimilarLines(text, oldString) };
  if (count > 1 && !replaceAll) return { kind: 'ambiguous', count };
  const first = text.indexOf(oldString);
  const firstLine = text.slice(0, first).split('\n').length;
  const next = replaceAll
    ? text.split(oldString).join(newString)
    : text.slice(0, first) + newString + text.slice(first + oldString.length);
  return { kind: 'ok', text: next, count: replaceAll ? count : 1, firstLine };
}
