import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { plural } from './read.ts';
import { defineTool } from './types.ts';

export const GLOB_LIMIT = 200;
const ALWAYS_SKIPPED = new Set(['node_modules', '.git']);

const skippedSegment = (rel: string) =>
  rel.split('/').some((part) => ALWAYS_SKIPPED.has(part));

/** Every non-ignored file under the root, per git (all .gitignore files, global excludes). */
async function gitFiles(root: string): Promise<string[] | null> {
  if (!Bun.which('git')) return null;
  const proc = Bun.spawn(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  const [out, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (code !== 0) return null; // Not a git repository.
  return [...new Set(out.split('\0').filter((p) => p !== ''))];
}

/**
 * Outside a git repo: an approximation of the root .gitignore (no negation, no nested files).
 * Patterns with an inner slash are anchored to the root; others match at any depth.
 */
export function gitignoreMatchers(text: string): ((rel: string) => boolean)[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line !== '' && !line.startsWith('#') && !line.startsWith('!'),
    )
    .map((line) => {
      const pattern = line.replace(/\/+$/, '');
      const anchored = pattern.includes('/');
      const base = anchored ? pattern.replace(/^\//, '') : `**/${pattern}`;
      const self = new Bun.Glob(base);
      const inside = new Bun.Glob(`${base}/**`);
      return (rel: string) => self.match(rel) || inside.match(rel);
    });
}

function walkFiles(root: string): string[] {
  const ignoreFile = join(root, '.gitignore');
  const ignored = existsSync(ignoreFile)
    ? gitignoreMatchers(readFileSync(ignoreFile, 'utf8'))
    : [];
  const isIgnored = (rel: string) => ignored.some((m) => m(rel));
  const files: string[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ALWAYS_SKIPPED.has(entry.name)) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isIgnored(rel)) continue;
      if (entry.isDirectory()) visit(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  visit(root, '');
  return files;
}

/**
 * Every file the glob tool searches, unsorted and uncapped: git's view in a repo (all ignore
 * files), the root-.gitignore walk outside one. The UI's @ picker lists files with this too.
 */
export async function projectFiles(root: string): Promise<string[]> {
  const files = (await gitFiles(root)) ?? walkFiles(root);
  return files.filter((rel) => !skippedSegment(rel));
}

/** Makes a model-supplied pattern relative to the root with forward slashes. */
function normalisePattern(root: string, pattern: string): string | null {
  let p = pattern.trim().replace(/\\/g, '/');
  if (isAbsolute(p)) {
    const rel = relative(root, p);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    p = rel.split(sep).join('/');
  }
  return p.replace(/^(\.\/)+/, '');
}

export const globTool = defineTool({
  name: 'glob',
  kind: 'read',
  description:
    'Find files by glob pattern, e.g. "src/**/*.ts" or "**/package.json". "*.ts" matches only the project root; use "**/" to search deeper. Respects .gitignore, skips node_modules and .git, newest first.',
  schema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe('Glob pattern relative to the project root'),
  }),
  async run({ pattern }, { projectRoot }) {
    const normalised = normalisePattern(projectRoot, pattern);
    if (normalised === null) {
      return {
        ok: false,
        output: `The pattern ${pattern} points outside the project (${projectRoot}).`,
        hint: 'Use a pattern relative to the project root.',
      };
    }
    const glob = new Bun.Glob(normalised);
    const candidates = await projectFiles(projectRoot);

    const matches: { rel: string; mtimeMs: number }[] = [];
    for (const rel of candidates) {
      if (!glob.match(rel)) continue;
      try {
        const stat = statSync(join(projectRoot, rel));
        // Deleted-but-tracked files and submodule directories aren't results.
        if (stat.isFile()) matches.push({ rel, mtimeMs: stat.mtimeMs });
      } catch {
        // Gone since git listed it.
      }
    }

    if (matches.length === 0) {
      const output = `No files match ${normalised}.`;
      if (normalised.includes('/'))
        return { ok: true, output, summary: '0 files' };
      return {
        ok: true,
        output,
        summary: '0 files',
        hint: `To search subfolders too, use "**/${normalised}".`,
      };
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    const shown = matches.slice(0, GLOB_LIMIT).map((m) => m.rel);
    const rest = matches.length - shown.length;
    const footer =
      rest > 0 ? `\n(${rest} more not shown; use a narrower pattern.)` : '';
    return {
      ok: true,
      output: shown.join('\n') + footer,
      summary: plural(matches.length, 'file'),
    };
  },
});
