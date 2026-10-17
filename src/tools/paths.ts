import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

export type ResolvedPath =
  | { ok: true; abs: string; rel: string }
  | { ok: false; output: string; hint: string };

const MAX_LINK_HOPS = 40;

/** The root's real path. Call once per session, and compare targets against this. */
export function realRoot(root: string): string {
  return realpathSync.native(resolve(root));
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** Project-relative path with forward slashes, for messages and listings. */
export function displayPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/') || '.';
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Real path of `path`, even when it (or its tail) doesn't exist yet. The nearest existing
 * ancestor is resolved for real; a dangling symlink is followed by hand so that a link to a
 * missing file outside the root can't pass for a new file inside it.
 */
function realPathOf(path: string, hops = 0): string {
  if (hops > MAX_LINK_HOPS)
    throw new Error(`too many symlink hops resolving ${path}`);
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        try {
          return join(realpathSync.native(current), ...missing);
        } catch (error) {
          if (errno(error) !== 'ENOENT') throw error;
          const target = resolve(dirname(current), readlinkSync(current));
          return realPathOf(join(target, ...missing), hops + 1);
        }
      }
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a model-supplied path against the project root. Anything that lands outside the
 * root, lexically or through a symlink, is refused.
 */
export function resolveInRoot(root: string, input: string): ResolvedPath {
  const trimmed = input.trim();
  if (trimmed === '') {
    return {
      ok: false,
      output: 'No path was given.',
      hint: 'Pass a file path relative to the project root.',
    };
  }
  const candidate = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(root, trimmed);
  const real = realPathOf(candidate);
  if (!isInside(root, real)) {
    const via = isInside(root, candidate) ? ' through a symlink' : '';
    return {
      ok: false,
      output: `${trimmed} resolves${via} to ${real}, which is outside the project (${root}).`,
      hint: 'Only paths inside the project root can be used.',
    };
  }
  return { ok: true, abs: real, rel: displayPath(root, real) };
}
