import { describe, expect, test } from 'bun:test';
import { gitignoreMatchers, globTool } from '../../src/tools/glob.ts';
import { call, cleanUpTempProjects, tempProject } from './helpers.ts';

cleanUpTempProjects();

type Project = ReturnType<typeof tempProject>;
const glob = (p: Project, pattern: string) =>
  call(globTool, { pattern }, p.ctx());

function gitInit(root: string) {
  const result = Bun.spawnSync(['git', 'init', '-q'], { cwd: root });
  if (result.exitCode !== 0) throw new Error('git init failed');
}

/** Gives each file a distinct mtime: later in the list is newer. */
function age(p: Project, rels: string[]) {
  for (const [i, rel] of rels.entries()) p.touch(rel, 1_700_000_000 + i * 60);
}

describe('glob', () => {
  test('matches a pattern, newest first, in a git repo respecting .gitignore', async () => {
    const p = tempProject({
      '.gitignore': 'dist/\n*.log\n',
      'src/a.ts': '',
      'src/b.ts': '',
      'src/nested/c.ts': '',
      'dist/bundle.ts': '',
      'debug.log': '',
      'node_modules/pkg/index.ts': '',
    });
    gitInit(p.root);
    age(p, ['src/b.ts', 'src/nested/c.ts', 'src/a.ts']);
    expect((await glob(p, '**/*.ts')).output).toBe(
      'src/a.ts\nsrc/nested/c.ts\nsrc/b.ts',
    );
    expect((await glob(p, '**/*.log')).output).toBe('No files match **/*.log.');
  });

  test('outside a git repo, applies an approximation of the root .gitignore', async () => {
    const p = tempProject({
      '.gitignore': '# build output\nbuild\n/coverage/\n*.tmp\n',
      'keep.ts': '',
      'build/out.ts': '',
      'pkg/build/out.ts': '',
      'coverage/x.ts': '',
      'scratch.tmp': '',
      'node_modules/m/i.ts': '',
      '.git/HEAD': '',
    });
    expect((await glob(p, '**/*')).output.split('\n').sort()).toEqual([
      '.gitignore',
      'keep.ts',
    ]);
  });

  test('"*.ts" only matches the root and suggests **/ when nothing matches', async () => {
    const p = tempProject({ 'src/a.ts': '' });
    const result = await glob(p, '*.ts');
    expect(result).toEqual({
      ok: true,
      output: 'No files match *.ts.',
      summary: '0 files',
      hint: 'To search subfolders too, use "**/*.ts".',
    });
  });

  test('caps at 200 results with a count of the rest', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 230 }, (_, i) => [
        `f/${String(i).padStart(3, '0')}.txt`,
        '',
      ]),
    );
    const p = tempProject(files);
    const lines = (await glob(p, 'f/*.txt')).output.split('\n');
    expect(lines.filter((l) => l.endsWith('.txt'))).toHaveLength(200);
    expect(lines.at(-1)).toBe('(30 more not shown; use a narrower pattern.)');
  });

  test('accepts ./ prefixes and absolute patterns inside the root, refuses ones outside', async () => {
    const p = tempProject({ 'src/a.ts': '' });
    expect((await glob(p, './src/*.ts')).output).toBe('src/a.ts');
    expect((await glob(p, `${p.root}/src/*.ts`)).output).toBe('src/a.ts');
    expect((await glob(p, `${p.outside}/*`)).ok).toBe(false);
  });

  test('gitignoreMatchers handles anchored, unanchored and directory patterns', () => {
    const [anchored, anywhere, dirOnly] = gitignoreMatchers(
      '/out\n*.bak\nlogs/\n',
    );
    expect(anchored?.('out/x')).toBe(true);
    expect(anchored?.('src/out/x')).toBe(false);
    expect(anywhere?.('a/b/c.bak')).toBe(true);
    expect(dirOnly?.('srv/logs/today.txt')).toBe(true);
  });
});
