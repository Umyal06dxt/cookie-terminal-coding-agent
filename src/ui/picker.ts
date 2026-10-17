/**
 * The "/" command list and the "@" file picker: which one is open, what it shows, and what
 * picking an entry does to the input. Pure; the file list is passed in.
 */

export interface Command {
  name: string;
  description: string;
}

/** Only commands that work today; the rest of docs/design.md's list arrives with its features. */
export const COMMANDS: readonly Command[] = [
  { name: '/help', description: 'Keys and commands' },
  { name: '/clear', description: 'Start a fresh conversation' },
  { name: '/exit', description: 'Quit cookie' },
];

export const PICKER_ROWS = 6;

export type Picker =
  | { kind: 'none' }
  | { kind: 'command'; query: string; matches: Command[] }
  | {
      kind: 'file';
      query: string;
      /** Where the "@" sits in the text. */
      start: number;
      matches: string[];
    };

/**
 * Subsequence match: every query character appears in order. Higher is better: consecutive
 * runs, matches at the start of a path segment, and matches in the file name all score more.
 * Null when it doesn't match.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query === '') return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const nameStart = c.lastIndexOf('/') + 1;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const ch of q) {
    const found = c.indexOf(ch, at);
    if (found === -1) return null;
    score += 1;
    if (found === previous + 1) score += 3;
    const before = c[found - 1];
    if (
      found === 0 ||
      before === '/' ||
      before === '.' ||
      before === '-' ||
      before === '_'
    )
      score += 2;
    if (found >= nameStart) score += 1;
    previous = found;
    at = found + 1;
  }
  // Shorter paths win ties.
  return score - c.length / 1000;
}

export function fuzzyFilter(
  query: string,
  candidates: readonly string[],
  limit = PICKER_ROWS,
): string[] {
  const scored: { path: string; score: number }[] = [];
  for (const path of candidates) {
    const score = fuzzyScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.path);
}

/** The "@word" the cursor is in, if any. "@" must start the input or follow whitespace. */
export function mentionAt(
  text: string,
  cursor: number,
): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

/** What should be open for this input. */
export function pickerFor(
  text: string,
  cursor: number,
  files: readonly string[],
): Picker {
  if (/^\/\S*$/.test(text)) {
    const matches = COMMANDS.filter((c) => c.name.startsWith(text));
    if (matches.length > 0) return { kind: 'command', query: text, matches };
  }
  const mention = mentionAt(text, cursor);
  if (mention) {
    return {
      kind: 'file',
      ...mention,
      matches: fuzzyFilter(mention.query, files),
    };
  }
  return { kind: 'none' };
}

/** The input after choosing entry `index`, and where the cursor goes. */
export function applyPick(
  picker: Picker,
  index: number,
  text: string,
  cursor: number,
): { text: string; cursor: number } | null {
  if (picker.kind === 'command') {
    const command = picker.matches[index];
    return command ? { text: command.name, cursor: command.name.length } : null;
  }
  if (picker.kind === 'file') {
    const path = picker.matches[index];
    if (path === undefined) return null;
    const inserted = `@${path} `;
    return {
      text: text.slice(0, picker.start) + inserted + text.slice(cursor),
      cursor: picker.start + inserted.length,
    };
  }
  return null;
}
