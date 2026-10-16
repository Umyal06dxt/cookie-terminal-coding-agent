import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse, TomlError } from 'smol-toml';
import type { z } from 'zod';
import { type CookieConfig, configSchema, MODEL_KEYS } from './schema.ts';

type Table = Record<string, unknown>;

export interface ConfigSource {
  path: string;
  data: Table;
}

export type LoadResult =
  | { ok: true; config: CookieConfig; sources: string[] }
  | { ok: false; message: string };

export interface LoadOptions {
  /** Defaults to the user's home directory. */
  home?: string;
  /** Where to start looking for the repo root. Defaults to process.cwd(). */
  cwd?: string;
}

/** Walks up from `start` to the nearest directory holding `.git`; falls back to `start`. */
export function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function configPaths(options: LoadOptions = {}): {
  user: string;
  project: string;
} {
  const home = options.home ?? homedir();
  const root = findRepoRoot(options.cwd ?? process.cwd());
  return {
    user: join(home, '.config', 'cookie', 'cookie.toml'),
    project: join(root, '.cookie', 'cookie.toml'),
  };
}

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ReadResult =
  | { ok: true; source: ConfigSource | null }
  | { ok: false; message: string };

function readToml(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, source: null };
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Cookie couldn't read ${path}: ${reason}` };
  }
  try {
    return { ok: true, source: { path, data: parse(text) } };
  } catch (error) {
    if (error instanceof TomlError) {
      const reason = error.message.split('\n')[0] ?? 'syntax error';
      return {
        ok: false,
        message: `${path}:${error.line}:${error.column} is not valid TOML: ${reason}`,
      };
    }
    throw error;
  }
}

/** Deep-merges tables; values in `override` win. Arrays and scalars are replaced whole. */
export function mergeTables(base: Table, override: Table): Table {
  const out: Table = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prev = out[key];
    out[key] =
      isTable(prev) && isTable(value) ? mergeTables(prev, value) : value;
  }
  return out;
}

function lookup(data: Table, path: readonly PropertyKey[]): unknown {
  let node: unknown = data;
  for (const key of path) {
    if (!isTable(node)) return undefined;
    node = node[String(key)];
  }
  return node;
}

/** `['models', 'workhorse']` → `[models] workhorse`, the way the key appears in the file. */
function fieldName(path: readonly PropertyKey[]): string {
  const parts = path.map(String);
  if (parts.length === 0) return 'the top level';
  if (parts.length === 1) return `[${parts[0]}]`;
  return `[${parts.slice(0, -1).join('.')}] ${parts.at(-1)}`;
}

function describeIssue(
  issue: z.core.$ZodIssue,
  sources: readonly ConfigSource[],
  candidates: readonly string[],
): string[] {
  // The file that last set this field is the one to fix; later sources override earlier ones.
  const owner = (path: readonly PropertyKey[]) =>
    [...sources].reverse().find((s) => lookup(s.data, path) !== undefined)
      ?.path;

  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => {
      const path = [...issue.path, key];
      return `${owner(path) ?? candidates[0]}: unknown key ${fieldName(path)}`;
    });
  }
  const file = owner(issue.path);
  if (file === undefined) {
    const keys =
      issue.path.length === 1 && issue.path[0] === 'models'
        ? ` (${MODEL_KEYS.join(', ')})`
        : '';
    return [
      `missing ${fieldName(issue.path)}${keys}: add it to ${candidates.join(' or ')}`,
    ];
  }
  return [`${file}: ${fieldName(issue.path)}: ${issue.message}`];
}

/** Validates already-parsed sources, lowest precedence first. Exposed for tests. */
export function resolveConfig(
  sources: readonly ConfigSource[],
  candidates: readonly string[],
): LoadResult {
  const merged = sources.reduce<Table>(
    (acc, s) => mergeTables(acc, s.data),
    {},
  );
  const parsed = configSchema.safeParse(merged);
  if (parsed.success) {
    return {
      ok: true,
      config: parsed.data,
      sources: sources.map((s) => s.path),
    };
  }
  const lines = parsed.error.issues.flatMap((i) =>
    describeIssue(i, sources, candidates),
  );
  const unique = [...new Set(lines)];
  return {
    ok: false,
    message: `Cookie's config has problems:\n${unique.map((l) => `  - ${l}`).join('\n')}`,
  };
}

/** Loads ~/.config/cookie/cookie.toml, then <repo>/.cookie/cookie.toml on top of it. */
export function loadConfig(options: LoadOptions = {}): LoadResult {
  const paths = configPaths(options);
  const sources: ConfigSource[] = [];
  for (const path of [paths.user, paths.project]) {
    const read = readToml(path);
    if (!read.ok) return read;
    if (read.source) sources.push(read.source);
  }
  return resolveConfig(sources, [paths.user, paths.project]);
}
