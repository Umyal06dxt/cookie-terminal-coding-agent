import { describe, expect, test } from 'bun:test';
import { statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTool } from '../../src/tools/read.ts';
import { call, IS_WINDOWS, tempProject, useTempProjects } from './helpers.ts';

useTempProjects();

const read = (p: ReturnType<typeof tempProject>, args: object) =>
  call(readTool, args, p.ctx());

describe('read', () => {
  test('numbers lines from 1 like cat -n and records a full read', async () => {
    const p = tempProject({ 'a.ts': 'one\ntwo\nthree\n' });
    const result = await read(p, { file_path: 'a.ts' });
    expect(result).toEqual({
      ok: true,
      output: '     1\tone\n     2\ttwo\n     3\tthree',
    });
    const stat = statSync(p.path('a.ts'));
    expect(p.ledger.get(p.path('a.ts'))).toEqual({
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      full: true,
    });
  });

  test('CRLF files show no carriage returns', async () => {
    const p = tempProject({ 'win.txt': 'alpha\r\nbeta\r\n' });
    const result = await read(p, { file_path: 'win.txt' });
    expect(result.output).toBe('     1\talpha\n     2\tbeta');
    expect(result.output).not.toContain('\r');
  });

  test('a missing final newline still reads every line', async () => {
    const p = tempProject({ 'a.txt': 'x\ny' });
    expect((await read(p, { file_path: 'a.txt' })).output).toBe(
      '     1\tx\n     2\ty',
    );
  });

  test('offset and limit read a window and say how to continue; the ledger marks it partial', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const p = tempProject({ 'big.txt': lines });
    const result = await read(p, { file_path: 'big.txt', offset: 3, limit: 2 });
    expect(result.output).toBe(
      '     3\tline 3\n     4\tline 4\n\n(Showing lines 3-4 of 10; continue with offset=5.)',
    );
    expect(p.ledger.get(p.path('big.txt'))?.full).toBe(false);
  });

  test('defaults to 2000 lines', async () => {
    const p = tempProject({
      'huge.txt': Array.from({ length: 2500 }, (_, i) => `${i + 1}`).join('\n'),
    });
    const result = await read(p, { file_path: 'huge.txt' });
    expect(result.output).toContain('  2000\t2000');
    expect(result.output).not.toContain('2001\t');
    expect(result.output).toContain('continue with offset=2001');
  });

  test('an offset past the end says how long the file is', async () => {
    const p = tempProject({ 'a.txt': 'x\n' });
    const result = await read(p, { file_path: 'a.txt', offset: 5 });
    expect(result).toMatchObject({
      ok: false,
      output: 'a.txt has 1 lines, so offset 5 is past the end.',
    });
  });

  test('an empty file says so and counts as fully read', async () => {
    const p = tempProject({ 'empty.ts': '' });
    expect(await read(p, { file_path: 'empty.ts' })).toEqual({
      ok: true,
      output: 'The file is empty.',
    });
    expect(p.ledger.get(p.path('empty.ts'))?.full).toBe(true);
  });

  test('binary files are refused with their type', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
    ]);
    const p = tempProject({
      'chip.png': png,
      'blob.bin': new Uint8Array([1, 2, 0, 3]),
    });
    expect(await read(p, { file_path: 'chip.png' })).toEqual({
      ok: false,
      output:
        "chip.png is a binary file (PNG image), so it can't be read as text.",
    });
    expect((await read(p, { file_path: 'blob.bin' })).output).toContain(
      '(binary data)',
    );
    expect(p.ledger.size).toBe(0);
  });

  test('UTF-8 with emoji reads intact', async () => {
    const p = tempProject({ 'chip.md': 'cookie 🍪 crumbs\n' });
    expect((await read(p, { file_path: 'chip.md' })).output).toBe(
      '     1\tcookie 🍪 crumbs',
    );
  });

  test('missing files and directories get a recovery hint', async () => {
    const p = tempProject({ 'src/a.ts': 'x' });
    expect(await read(p, { file_path: 'nope.ts' })).toMatchObject({
      ok: false,
      hint: expect.stringContaining('glob'),
    });
    expect((await read(p, { file_path: 'src' })).output).toBe(
      'src is a directory, not a file.',
    );
  });

  test.skipIf(IS_WINDOWS)(
    'refuses to follow a symlink out of the root',
    async () => {
      const p = tempProject();
      writeFileSync(join(p.outside, 'secret'), 'top secret');
      symlinkSync(join(p.outside, 'secret'), p.path('innocent.txt'));
      const result = await read(p, { file_path: 'innocent.txt' });
      expect(result.ok).toBe(false);
      expect(result.output).not.toContain('top secret');
    },
  );
});
