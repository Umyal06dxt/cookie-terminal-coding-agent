import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  basename,
  commandWords,
  innerScript,
  isShell,
  parseShell,
  type Segment,
  xargsCommand,
} from './shell-parse.ts';

export interface PathContext {
  /** Real, absolute project root; relative paths and `cd` resolve from here. */
  projectRoot: string;
  home?: string;
  /** Where the command starts, when not the root (inside `cd x && bash -c "…"`). */
  cwd?: string;
}

const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlcmd',
  'clickhouse-client',
  'cockroach',
]);
const FETCHERS = new Set(['curl', 'wget']);
const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'bun',
  'deno',
]);
/** git subcommands where a short -f/-D throws work away. */
const GIT_FORCE_SHORT = new Set([
  'checkout',
  'switch',
  'branch',
  'clean',
  'rm',
  'worktree',
  'tag',
  'stash',
]);
const WRITERS_ALL_ARGS = new Set([
  'touch',
  'mkdir',
  'rmdir',
  'truncate',
  'shred',
  'unlink',
]);
const WRITERS_AFTER_FIRST = new Set(['chmod', 'chown', 'chgrp']);
const WRITERS_LAST_ARG = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'scp']);
const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Harmless redirect targets. */
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/**
 * Why a shell command must always be confirmed, or an empty list. Checks every part of a
 * chain (&&, ||, ;, |), the script inside `bash -c "…"`, and follows `cd` between parts.
 */
export function destructiveReasons(
  command: string,
  ctx: PathContext,
): string[] {
  const reasons = new Set<string>();
  check(parseShell(command), ctx, reasons, 0);
  return [...reasons];
}

function check(
  segments: Segment[],
  ctx: PathContext,
  reasons: Set<string>,
  depth: number,
): void {
  const home = ctx.home ?? homedir();
  // Resolved, so it compares equal to resolved paths on every platform.
  const root = resolve(ctx.projectRoot);
  let cwd = ctx.cwd === undefined ? root : resolve(ctx.cwd);
  const where = (path: string) => locate(path, cwd, root, home);
  const nested = (script: string) => {
    if (depth < 3)
      check(parseShell(script), { ...ctx, cwd }, reasons, depth + 1);
    else reasons.add('nested too deeply to check');
  };

  segments.forEach((segment, i) => {
    let words = commandWords(segment);
    const viaXargs = xargsCommand(words);
    if (viaXargs !== null) words = viaXargs;
    const [cmd = '', ...args] = words;
    const name = basename(cmd);

    const inner = innerScript(words);
    if (inner !== null) nested(inner);
    for (const body of segment.substitutions) nested(body);
    if (segment.unclosed)
      reasons.add('an unclosed $( or ` hides part of the command');
    if (
      viaXargs !== null &&
      (name === 'rm' ||
        WRITERS_ALL_ARGS.has(name) ||
        WRITERS_LAST_ARG.has(name))
    )
      reasons.add(
        `xargs ${name}: its targets come from the pipe and can't be checked`,
      );

    if (name === 'sudo' || name === 'doas')
      reasons.add(`${name}: runs as another user`);
    if (name === 'cd') {
      const target = args.find((a) => !a.startsWith('-'));
      cwd =
        target === undefined ? home : (resolvePath(target, cwd, home) ?? cwd);
      return;
    }
    if (name === 'rm') checkRm(args, where, reasons);
    if (name === 'git') checkGit(args, reasons);
    if (PUBLISHERS.has(name) && args[0] === 'publish')
      reasons.add(`${name} publish: publishes a package`);
    if (name === 'terraform' && (args[0] === 'apply' || args[0] === 'destroy'))
      reasons.add(`terraform ${args[0]}: changes real infrastructure`);
    if (name === 'kubectl' && args[0] === 'delete')
      reasons.add('kubectl delete: deletes cluster resources');
    if (name === 'mkfs' || name.startsWith('mkfs.'))
      reasons.add(`${name}: formats a disk`);
    if (name === 'dd') {
      const out = args.find((a) => a.startsWith('of='))?.slice(3);
      if (out !== undefined && !SINKS.has(out))
        noteWrite(where(out), out, 'dd', reasons);
    }
    if (args.some((a) => /^--force(-with-lease)?(=|$)/.test(a)))
      reasons.add(`${name} --force: a force flag`);

    if (
      SQL_CLIENTS.has(name) &&
      /\b(DROP|TRUNCATE)\b/i.test(chainText(segments))
    )
      reasons.add(`${name}: DROP or TRUNCATE in a SQL client`);

    // curl … | sh, and sh <(curl …) / sh -c "$(curl …)".
    let feeder = '';
    for (let k = i - 1; k >= 0 && segments[k]?.next === '|'; k--) {
      const fed = basename(commandWords(segments[k] as Segment)[0] ?? '');
      if (FETCHERS.has(fed)) feeder = fed;
    }
    const runsCode = isShell(name) || INTERPRETERS.has(name);
    if (runsCode && FETCHERS.has(feeder))
      reasons.add(`${feeder} | ${name}: runs a script from the internet`);
    if (
      runsCode &&
      segment.substitution &&
      /\b(curl|wget)\b/.test(segment.text)
    )
      reasons.add(`${name}: runs a downloaded script`);

    for (const r of segment.redirects) {
      if (
        r.op.includes('>') &&
        !r.target.startsWith('&') &&
        !SINKS.has(r.target)
      ) {
        noteWrite(
          where(r.target),
          r.target,
          `redirect to ${r.target}`,
          reasons,
        );
      }
    }
    // -o/--output FILE (curl, git log, compilers…) writes wherever it points.
    args.forEach((a, k) => {
      const out = a.startsWith('--output=')
        ? a.slice('--output='.length)
        : a === '-o' || a === '--output'
          ? args[k + 1]
          : undefined;
      if (out !== undefined && out !== '-' && !SINKS.has(out))
        noteWrite(
          where(out),
          out,
          `${name} ${a.split('=')[0]} ${out}`,
          reasons,
        );
    });
    const paths = args.filter((a) => !a.startsWith('-'));
    let targets: string[] = [];
    if (WRITERS_ALL_ARGS.has(name) || name === 'tee') targets = paths;
    else if (WRITERS_AFTER_FIRST.has(name)) targets = paths.slice(1);
    else if (WRITERS_LAST_ARG.has(name)) targets = paths.slice(-1);
    for (const target of targets)
      noteWrite(where(target), target, `${name} ${target}`, reasons);
  });
}

type Location =
  | 'inside'
  | 'root'
  | 'home'
  | 'etc'
  | 'temp'
  | 'outside'
  | 'unknown';

function resolvePath(path: string, cwd: string, home: string): string | null {
  let p = path;
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  // ~user is someone's home folder; which one isn't worth guessing.
  else if (p.startsWith('~')) return null;
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (p.includes('$') || p.includes('`')) return null;
  return isAbsolute(p) ? resolve(p) : resolve(join(cwd, p));
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function locate(
  path: string,
  cwd: string,
  root: string,
  home: string,
): Location {
  // A trailing glob acts on the folder it sits in: "*" and ".*" on the cwd, "/*" on /.
  const dir = /^(\*|\.\*)$/.test(path)
    ? '.'
    : path.replace(/\/(\*|\.\*)$/, '/');
  const resolved = resolvePath(dir, cwd, home);
  if (resolved === null) return 'unknown';
  if (resolved === root) return 'root';
  if (within(resolved, root)) return 'inside';
  if (resolved === '/etc' || within(resolved, '/etc')) return 'etc';
  if (within(resolved, tmpdir()) || within(resolved, '/tmp')) return 'temp';
  if (within(resolved, home)) return 'home';
  return 'outside';
}

function noteWrite(
  at: Location,
  target: string,
  what: string,
  reasons: Set<string>,
): void {
  if (at === 'etc') reasons.add(`${what}: writes to /etc`);
  else if (at === 'home')
    reasons.add(`${what}: writes to your home folder outside the project`);
  else if (at === 'outside') reasons.add(`${what}: writes outside the project`);
  else if (at === 'unknown')
    reasons.add(`${what}: writes to ${target}, which can't be checked`);
}

function checkRm(
  args: string[],
  where: (p: string) => Location,
  reasons: Set<string>,
): void {
  const flags = args.filter((a) => a.startsWith('-'));
  const recursive = flags.some(
    (f) => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)),
  );
  for (const target of args.filter((a) => !a.startsWith('-'))) {
    const at = where(target);
    if (at === 'root' && recursive)
      reasons.add(`rm -r ${target}: deletes the whole project`);
    else if (at === 'root' || at === 'inside' || at === 'temp') continue;
    else if (at === 'unknown')
      reasons.add(`rm ${target}: deletes a path that can't be checked`);
    else reasons.add(`rm ${target}: deletes outside the project`);
  }
}

function checkGit(args: string[], reasons: Set<string>): void {
  // Skip global options: git -C dir, git -c key=value, git --git-dir=…
  let i = 0;
  const valued = ['-C', '-c', '--git-dir', '--work-tree', '--namespace'];
  while (i < args.length && (args[i] ?? '').startsWith('-'))
    i += valued.includes(args[i] ?? '') ? 2 : 1;
  const sub = args[i] ?? '';
  const rest = args.slice(i + 1);
  if (sub === 'push') reasons.add('git push: changes a remote');
  if (sub === 'reset' && rest.includes('--hard'))
    reasons.add('git reset --hard: discards uncommitted work');
  if (
    sub === 'clean' &&
    rest.some((a) => a === '--force' || /^-[a-zA-Z]*f/.test(a))
  )
    reasons.add('git clean -f: deletes untracked files');
  if (
    GIT_FORCE_SHORT.has(sub) &&
    sub !== 'clean' &&
    rest.some((a) => /^-[a-zA-Z]*[fD]/.test(a))
  )
    reasons.add(`git ${sub} with a force flag`);
}

function chainText(segments: Segment[]): string {
  return segments.map((s) => s.text).join(' ');
}
