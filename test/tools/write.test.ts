import { describe, expect, test } from 'bun:test';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTool } from '../../src/tools/read.ts';
import { writeTool } from '../../src/tools/write.ts';
import { call, IS_WINDOWS, tempProject, useTempProjects } from './helpers.ts';

useTempProjects();

type Project = ReturnType<typeof tempProject>;
const write = (p: Project, file_path: string, content: string) =>
  call(writeTool, { file_path, content }, p.ctx());
const read = (p: Project, args: object) => call(readTool, args, p.ctx());

describe('write', () => {
  test('creates new files and their parent folders freely', async () => {
    const p = tempProject();
    const result = await write(p, 'src/deep/new.ts', 'export {};\n');
    expect(result).toEqual({
      ok: true,
      output: 'Created src/deep/new.ts (1 line).',
      summary: 'created, 1 line',
    });
    expect(p.read('src/deep/new.ts')).toBe('export {};\n');
    // Writing a file counts as knowing all of it, so it can be edited straight away.
    expect(p.ledger.get(p.path('src/deep/new.ts'))?.full).toBe(true);
  });

  test('refuses to overwrite a file that was never read', async () => {
    const p = tempProject({ 'a.ts': 'precious\n' });
    const result = await write(p, 'a.ts', 'gone');
    expect(result).toMatchObject({
      ok: false,
      hint: 'Read a.ts first, then try again.',
    });
    expect(p.read('a.ts')).toBe('precious\n');
  });

  test('refuses to overwrite after only a partial read', async () => {
    const p = tempProject({ 'a.ts': 'one\ntwo\nthree\n' });
    await read(p, { file_path: 'a.ts', limit: 1 });
    expect((await write(p, 'a.ts', 'x')).output).toBe(
      "You have only read part of a.ts, so it can't be overwritten.",
    );
  });

  test('a file over 2000 lines: the hint names a limit that covers it, and that read unlocks write', async () => {
    const p = tempProject({
      'long.txt': `${Array.from({ length: 2500 }, (_, i) => i).join('\n')}\n`,
    });
    await read(p, { file_path: 'long.txt' });
    const refused = await write(p, 'long.txt', 'short\n');
    expect(refused.hint).toBe(
      'Read long.txt with offset 1 and limit 2500 (it has 2500 lines), then try again.',
    );
    await read(p, { file_path: 'long.txt', offset: 1, limit: 2500 });
    expect((await write(p, 'long.txt', 'short\n')).ok).toBe(true);
  });

  test('overwrites after a full read', async () => {
    const p = tempProject({ 'a.ts': 'old\n' });
    await read(p, { file_path: 'a.ts' });
    expect(await write(p, 'a.ts', 'new\nlines\n')).toEqual({
      ok: true,
      output: 'Overwrote a.ts (2 lines).',
      summary: 'overwrote, 2 lines',
    });
    expect(p.read('a.ts')).toBe('new\nlines\n');
  });

  test('refuses to overwrite a file that changed on disk since the read', async () => {
    const p = tempProject({ 'a.ts': 'v1\n' });
    p.touch('a.ts', 1_700_000_000);
    await read(p, { file_path: 'a.ts' });
    writeFileSync(p.path('a.ts'), 'v2 from the editor\n');
    p.touch('a.ts', 1_700_000_500);
    expect((await write(p, 'a.ts', 'v3')).output).toBe(
      'File changed on disk since you read it; read it again.',
    );
    expect(p.read('a.ts')).toBe('v2 from the editor\n');
  });

  test('keeps a CRLF file CRLF when the model writes LF', async () => {
    const p = tempProject({ 'win.txt': 'a\r\nb\r\n' });
    await read(p, { file_path: 'win.txt' });
    await write(p, 'win.txt', 'x\ny\n');
    expect(p.read('win.txt')).toBe('x\r\ny\r\n');
  });

  test('refuses directories and paths outside the root', async () => {
    const p = tempProject({ 'src/a.ts': '' });
    expect((await write(p, 'src', 'x')).output).toContain('is a directory');
    expect((await write(p, '../outside/evil.sh', 'x')).output).toContain(
      'outside the project',
    );
    expect(existsSync(join(p.outside, 'evil.sh'))).toBe(false);
  });

  test.skipIf(IS_WINDOWS)(
    'never writes through a dangling symlink that points outside',
    async () => {
      const p = tempProject();
      symlinkSync(join(p.outside, 'planted.txt'), p.path('link'));
      const result = await write(p, 'link', 'payload');
      expect(result.ok).toBe(false);
      expect(existsSync(join(p.outside, 'planted.txt'))).toBe(false);
    },
  );
});
