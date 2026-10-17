/**
 * Just enough shell parsing to judge a command: split a chain on && || ; | & and newlines,
 * unquote words, and pull out redirections. Not a shell: anything it can't see through
 * ($(…), backticks, <(…)) is flagged so callers never auto-allow it.
 */

export type Operator = '&&' | '||' | ';' | '|' | '&';

export interface Redirect {
  op: string;
  target: string;
}

export interface Segment {
  /** Unquoted words; leading NAME=value assignments and redirections removed. */
  words: string[];
  redirects: Redirect[];
  /** The segment as written, trimmed, whitespace collapsed outside quotes. */
  text: string;
  /** The operator after this segment; null for the last one. */
  next: Operator | null;
  /** Contains command or process substitution, so its real effect is unknown. */
  substitution: boolean;
  /** The scripts inside $(…), `…`, <(…) and >(…), to be checked like the outer command. */
  substitutions: string[];
  /** A $( or ` that never closes: nothing about it can be checked. */
  unclosed: boolean;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT = /^(\d*|&)(>>?|<<?<?|>&|<>)(.*)$/;

interface RawWord {
  value: string;
  /** True when any part of it was quoted (so "&&" in quotes is a word, not an operator). */
  quoted: boolean;
}

export function parseShell(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: RawWord[] = [];
  let text = '';
  let word: RawWord | null = null;
  let substitution = false;
  let bodies: string[] = [];
  let unclosed = false;
  const take = (body: string | null) => {
    substitution = true;
    if (body === null) unclosed = true;
    else bodies.push(body);
  };

  const endWord = () => {
    if (word) words.push(word);
    word = null;
  };
  const endSegment = (next: Operator | null) => {
    endWord();
    if (words.length > 0 || next !== null) {
      segments.push({
        ...build(words, text.trim().replace(/\s+/g, ' '), next, substitution),
        substitutions: bodies,
        unclosed,
      });
    }
    words = [];
    text = '';
    substitution = false;
    bodies = [];
    unclosed = false;
  };
  const append = (ch: string, quoted = false) => {
    word ??= { value: '', quoted: false };
    word.value += ch;
    if (quoted) word.quoted = true;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    const rest = command.slice(i);
    if (ch === '\\') {
      const escaped = command[i + 1];
      text += ch + (escaped ?? '');
      i++;
      if (escaped !== undefined && escaped !== '\n') append(escaped, true);
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const inner =
        end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      append(inner, true);
      text += end === -1 ? command.slice(i) : command.slice(i, end + 1);
      i = end === -1 ? command.length : end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let inner = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          inner += command[j + 1];
          j += 2;
          continue;
        }
        inner += command[j];
        j++;
      }
      for (const body of quotedSubstitutions(command.slice(i + 1, j)))
        take(body);
      append(inner, true);
      text += command.slice(i, j + 1);
      i = j;
      continue;
    }
    if (/^[$<>]\(/.test(rest) || ch === '`') {
      // Keep the whole $(…) in one word; its inner && and ; belong to it, not the chain.
      const open = ch === '`' ? i : i + 1;
      const close =
        ch === '`' ? closeBacktick(command, i) : closeParen(command, open);
      take(close === -1 ? null : command.slice(open + 1, close));
      const raw = close === -1 ? command.slice(i) : command.slice(i, close + 1);
      append(raw);
      text += raw;
      i = close === -1 ? command.length : close;
      continue;
    }
    const op = /^(&&|\|\||;|\||&(?!>))/.exec(rest)?.[1] as Operator | undefined;
    if (op && !(op === '&' && /[<>]$/.test(text))) {
      endSegment(op);
      i += op.length - 1;
      continue;
    }
    if (ch === '\n') {
      endSegment(';');
      continue;
    }
    text += ch;
    if (/\s/.test(ch)) {
      endWord();
      continue;
    }
    append(ch);
  }
  endSegment(null);
  // A trailing operator ("a &&") leaves an empty last segment; drop it.
  while (segments.length > 0 && segments.at(-1)?.words.length === 0)
    segments.pop();
  const last = segments.at(-1);
  if (last) last.next = null;
  return segments;
}

/** Index of the ")" closing the "(" at `open`, or -1. Skips quoted text and nesting. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      i = s.indexOf("'", i + 1);
      if (i === -1) return -1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      if (j >= s.length) return -1;
      i = j;
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

function closeBacktick(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  return -1;
}

/** $(…) and `…` bodies inside a double-quoted string; null for one that never closes. */
function quotedSubstitutions(raw: string): (string | null)[] {
  const found: (string | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') {
      i++;
      continue;
    }
    const tick = raw[i] === '`';
    if (!tick && !raw.startsWith('$(', i)) continue;
    const open = tick ? i : i + 1;
    const close = tick ? closeBacktick(raw, i) : closeParen(raw, open);
    found.push(close === -1 ? null : raw.slice(open + 1, close));
    if (close === -1) break;
    i = close;
  }
  return found;
}

function build(
  raw: RawWord[],
  text: string,
  next: Operator | null,
  substitution: boolean,
): Omit<Segment, 'substitutions' | 'unclosed'> {
  const words: string[] = [];
  const redirects: Redirect[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (!w) continue;
    if (!w.quoted) {
      const redirect = REDIRECT.exec(w.value);
      if (redirect) {
        const op = `${redirect[1] ?? ''}${redirect[2] ?? ''}`;
        let target = redirect[3] ?? '';
        if (target === '') {
          target = raw[i + 1]?.value ?? '';
          i++;
        }
        redirects.push({ op, target });
        continue;
      }
      if (words.length === 0 && ASSIGNMENT.test(w.value)) {
        continue;
      }
    }
    words.push(w.value);
  }
  return { words, redirects, text, next, substitution };
}

/** Wrappers that run the rest of the line as the command. `sudo` is reported, not skipped. */
/**
 * Wrappers that run the rest of the line as the command: the options that take a value, and
 * how many plain arguments come before the command (timeout's duration). `sudo` is reported
 * as destructive rather than peeled off.
 */
const WRAPPERS: Record<string, { values: readonly string[]; leading: number }> =
  {
    env: {
      values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
      leading: 0,
    },
    nohup: { values: [], leading: 0 },
    time: { values: ['-f', '--format', '-o', '--output'], leading: 0 },
    nice: { values: ['-n', '--adjustment'], leading: 0 },
    timeout: { values: ['-s', '--signal', '-k', '--kill-after'], leading: 1 },
    command: { values: [], leading: 0 },
    exec: { values: ['-a'], leading: 0 },
    builtin: { values: [], leading: 0 },
  };

/** The command a segment really runs: wrappers like `env`, `nice -n 10` and `timeout 30` peeled off. */
export function commandWords(segment: Segment): string[] {
  let words = segment.words;
  let wrapper = WRAPPERS[basename(words[0] ?? '')];
  while (wrapper) {
    let i = 1;
    while (i < words.length) {
      const w = words[i] ?? '';
      if (w.startsWith('-')) i += wrapper.values.includes(w) ? 2 : 1;
      else if (ASSIGNMENT.test(w)) i++;
      else break;
    }
    words = words.slice(i + wrapper.leading);
    wrapper = WRAPPERS[basename(words[0] ?? '')];
  }
  return words;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** xargs options that take a value. */
const XARGS_VALUE = new Set(['-n', '-I', '-L', '-P', '-d', '-E', '-s', '-a']);

/**
 * The command xargs runs, fed from stdin, or null when the segment isn't xargs. Its targets
 * come from the pipe, so they can't be checked.
 */
export function xargsCommand(words: readonly string[]): string[] | null {
  if (basename(words[0] ?? '') !== 'xargs') return null;
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-')) {
    i += XARGS_VALUE.has(words[i] ?? '') ? 2 : 1;
  }
  return words.slice(i);
}

/** `bash -c "a && b"` and `eval a && b` hide a chain in a string; this returns it, or null. */
export function innerScript(words: readonly string[]): string | null {
  const [cmd, ...args] = words;
  if (cmd === 'eval') return args.join(' ');
  if (cmd === undefined || !SHELLS.has(basename(cmd))) return null;
  const at = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
  return at === -1 ? null : (args[at + 1] ?? null);
}

export function basename(cmd: string): string {
  return cmd.slice(cmd.lastIndexOf('/') + 1);
}

export function isShell(cmd: string): boolean {
  return SHELLS.has(basename(cmd));
}

/**
 * Every command text a pattern should be matched against: the whole line, each part as
 * written, each part without wrappers (env, nohup, xargs…), and the same for every script
 * hidden in `bash -c`, `eval` or $(…). So a deny pattern can't be stepped around.
 */
export function commandTexts(command: string, depth = 0): string[] {
  const texts = [command];
  for (const segment of parseShell(command)) {
    let words = commandWords(segment);
    texts.push(segment.text, words.join(' '));
    const fed = xargsCommand(words);
    if (fed !== null) {
      words = fed;
      texts.push(words.join(' '));
    }
    if (depth >= 3) continue;
    const inner = innerScript(words);
    for (const script of [
      ...(inner === null ? [] : [inner]),
      ...segment.substitutions,
    ]) {
      texts.push(...commandTexts(script, depth + 1));
    }
  }
  return [...new Set(texts.filter((t) => t.trim() !== ''))];
}
