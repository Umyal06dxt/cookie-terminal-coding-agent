import { describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInRoot } from '../../src/tools/paths.ts';
import { IS_WINDOWS, tempProject, useTempProjects } from './helpers.ts';

useTempProjects();

describe('resolveInRoot', () => {
  test('resolves relative and absolute paths inside the root', () => {
    const p = tempProject({ 'src/a.ts': 'x' });
    expect(resolveInRoot(p.root, 'src/a.ts')).toEqual({
      ok: true,
      abs: p.path('src/a.ts'),
      rel: 'src/a.ts',
    });
    expect(resolveInRoot(p.root, `${p.path('src/a.ts')}`)).toMatchObject({
      ok: true,
      rel: 'src/a.ts',
    });
    expect(resolveInRoot(p.root, './src/../src/a.ts')).toMatchObject({
      ok: true,
      rel: 'src/a.ts',
    });
  });

  test('allows files that do not exist yet, in folders that do not exist yet', () => {
    const p = tempProject();
    expect(resolveInRoot(p.root, 'new/deep/file.ts')).toMatchObject({
      ok: true,
      rel: 'new/deep/file.ts',
    });
  });

  test('rejects .. escapes and absolute paths outside the root', () => {
    const p = tempProject();
    for (const input of [
      '../outside/x',
      join(p.outside, 'x'),
      '/etc/passwd',
      'a/../../outside',
    ]) {
      const result = resolveInRoot(p.root, input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.output).toContain('outside the project');
    }
  });

  test('rejects an empty path', () => {
    expect(resolveInRoot(tempProject().root, '  ').ok).toBe(false);
  });

  test.skipIf(IS_WINDOWS)('rejects a symlink that escapes the root', () => {
    const p = tempProject();
    writeFileSync(join(p.outside, 'secret.txt'), 'nope');
    symlinkSync(join(p.outside, 'secret.txt'), p.path('link.txt'));
    const result = resolveInRoot(p.root, 'link.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('through a symlink');
  });

  test.skipIf(IS_WINDOWS)(
    'rejects a symlinked directory that escapes, and paths beneath it',
    () => {
      const p = tempProject();
      symlinkSync(p.outside, p.path('out'));
      expect(resolveInRoot(p.root, 'out/new-file.ts').ok).toBe(false);
    },
  );

  test.skipIf(IS_WINDOWS)(
    'rejects a dangling symlink whose target is outside the root',
    () => {
      const p = tempProject();
      symlinkSync(join(p.outside, 'not-yet.txt'), p.path('dangling'));
      expect(resolveInRoot(p.root, 'dangling').ok).toBe(false);
    },
  );

  test.skipIf(IS_WINDOWS)(
    'allows a symlink that stays inside the root, keyed by its real path',
    () => {
      const p = tempProject({ 'real/a.ts': 'x' });
      mkdirSync(p.path('links'));
      symlinkSync(p.path('real/a.ts'), p.path('links/a.ts'));
      expect(resolveInRoot(p.root, 'links/a.ts')).toMatchObject({
        ok: true,
        abs: p.path('real/a.ts'),
      });
    },
  );
});
