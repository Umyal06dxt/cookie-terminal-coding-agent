import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { editTool } from '../../src/tools/edit.ts';
import { readTool } from '../../src/tools/read.ts';
import { call, tempProject, useTempProjects } from './helpers.ts';

useTempProjects();

type Project = ReturnType<typeof tempProject>;
const read = (p: Project, file_path: string) =>
  call(readTool, { file_path }, p.ctx());
const edit = (p: Project, args: object) => call(editTool, args, p.ctx());

describe('edit', () => {
  test('replaces one exact match and reports where', async () => {
    const p = tempProject({
      'oven.ts': 'const temp = 180;\nconst time = 12;\n',
    });
    await read(p, 'oven.ts');
    const result = await edit(p, {
      file_path: 'oven.ts',
      old_string: 'time = 12',
      new_string: 'time = 14',
    });
    expect(result).toEqual({
      ok: true,
      output: 'Edited oven.ts: replaced 1 occurrence, starting at line 2.',
      summary: 'replaced 1 occurrence',
    });
    expect(p.read('oven.ts')).toBe('const temp = 180;\nconst time = 14;\n');
  });

  test('requires a read first', async () => {
    const p = tempProject({ 'a.ts': 'x\n' });
    const result = await edit(p, {
      file_path: 'a.ts',
      old_string: 'x',
      new_string: 'y',
    });
    expect(result).toMatchObject({
      ok: false,
      hint: 'Read a.ts first, then try again.',
    });
    expect(p.read('a.ts')).toBe('x\n');
  });

  test('refuses when the file changed on disk since it was read', async () => {
    const p = tempProject({ 'a.ts': 'let crumbs = 1;\n' });
    p.touch('a.ts', 1_700_000_000);
    await read(p, 'a.ts');
    // Someone edits the file in their editor.
    writeFileSync(p.path('a.ts'), 'let crumbs = 2;\n');
    p.touch('a.ts', 1_700_000_100);
    const result = await edit(p, {
      file_path: 'a.ts',
      old_string: 'crumbs = 2',
      new_string: 'crumbs = 3',
    });
    expect(result).toMatchObject({
      ok: false,
      output: 'File changed on disk since you read it; read it again.',
    });
    expect(p.read('a.ts')).toBe('let crumbs = 2;\n');
    // Reading again clears the way.
    await read(p, 'a.ts');
    expect(
      (
        await edit(p, {
          file_path: 'a.ts',
          old_string: 'crumbs = 2',
          new_string: 'crumbs = 3',
        })
      ).ok,
    ).toBe(true);
  });

  test('a change that keeps the mtime is still caught by the size', async () => {
    const p = tempProject({ 'a.ts': 'abc\n' });
    p.touch('a.ts', 1_700_000_000);
    await read(p, 'a.ts');
    writeFileSync(p.path('a.ts'), 'abcdef\n');
    p.touch('a.ts', 1_700_000_000);
    expect(
      (await edit(p, { file_path: 'a.ts', old_string: 'abc', new_string: 'x' }))
        .ok,
    ).toBe(false);
  });

  test('two edits in a row both work: the ledger follows our own writes', async () => {
    const p = tempProject({ 'a.ts': 'one\ntwo\n' });
    await read(p, 'a.ts');
    expect(
      (
        await edit(p, {
          file_path: 'a.ts',
          old_string: 'one',
          new_string: 'uno',
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await edit(p, {
          file_path: 'a.ts',
          old_string: 'two',
          new_string: 'dos',
        })
      ).ok,
    ).toBe(true);
    expect(p.read('a.ts')).toBe('uno\ndos\n');
  });

  test('a missing old_string shows the 3 most similar lines', async () => {
    const p = tempProject({
      'bake.ts':
        'function preheat(oven) {\n  oven.temp = 180;\n}\nfunction cool(rack) {}\nconst x = 1;\n',
    });
    await read(p, 'bake.ts');
    const result = await edit(p, {
      file_path: 'bake.ts',
      old_string: '  oven.temp = 200;',
      new_string: '',
    });
    expect(result.ok).toBe(false);
    expect(result.output).toStartWith(
      'old_string was not found in bake.ts.\nThe most similar lines are:\n  line 2:   oven.temp = 180;',
    );
    expect(
      result.output.split('\n').filter((l) => l.startsWith('  line ')),
    ).toHaveLength(3);
  });

  test('more than one match says how many and asks for context', async () => {
    const p = tempProject({ 'a.ts': 'chip();\nchip();\nchip();\n' });
    await read(p, 'a.ts');
    const result = await edit(p, {
      file_path: 'a.ts',
      old_string: 'chip();',
      new_string: 'crumb();',
    });
    expect(result).toMatchObject({
      ok: false,
      output: 'old_string appears 3 times in a.ts.',
    });
    expect(result.hint).toContain('more surrounding lines');
  });

  test('replace_all replaces every match', async () => {
    const p = tempProject({ 'a.ts': 'chip();\nchip();\n' });
    await read(p, 'a.ts');
    const result = await edit(p, {
      file_path: 'a.ts',
      old_string: 'chip',
      new_string: 'crumb',
      replace_all: true,
    });
    expect(result.output).toBe(
      'Edited a.ts: replaced 2 occurrences, starting at line 1.',
    );
    expect(p.read('a.ts')).toBe('crumb();\ncrumb();\n');
  });

  test('CRLF files stay CRLF, untouched lines byte-identical', async () => {
    const p = tempProject({
      'win.cs': 'class A {\r\n  int x = 1;\r\n  int y = 2;\r\n}\r\n',
    });
    await read(p, 'win.cs');
    // The model saw LF lines from read and sends LF.
    const result = await edit(p, {
      file_path: 'win.cs',
      old_string: '  int x = 1;\n  int y = 2;',
      new_string: '  int x = 10;\n  int y = 20;\n  int z = 30;',
    });
    expect(result.ok).toBe(true);
    expect(p.read('win.cs')).toBe(
      'class A {\r\n  int x = 10;\r\n  int y = 20;\r\n  int z = 30;\r\n}\r\n',
    );
  });

  test('a BOM, a missing final newline and a stray CRLF in an LF file are preserved', async () => {
    const p = tempProject({ 'a.txt': '﻿first\r\nsecond\nthird\nlast' });
    await read(p, 'a.txt');
    await edit(p, {
      file_path: 'a.txt',
      old_string: 'third',
      new_string: 'THIRD',
    });
    expect(readFileSync(p.path('a.txt'), 'utf8')).toBe(
      '﻿first\r\nsecond\nTHIRD\nlast',
    );
  });

  test('$ patterns in new_string stay literal', async () => {
    const p = tempProject({ 'a.ts': 'price = X;\n' });
    await read(p, 'a.ts');
    await edit(p, {
      file_path: 'a.ts',
      old_string: 'X',
      new_string: "'$1 and $& and $$'",
    });
    expect(p.read('a.ts')).toBe("price = '$1 and $& and $$';\n");
  });

  test('refuses empty or no-op edits, missing files and non-UTF-8 files', async () => {
    const p = tempProject({
      'a.ts': 'x\n',
      'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    });
    await read(p, 'a.ts');
    await read(p, 'latin1.txt');
    expect(
      (await edit(p, { file_path: 'a.ts', old_string: '', new_string: 'y' }))
        .output,
    ).toContain('empty');
    expect(
      (await edit(p, { file_path: 'a.ts', old_string: 'x', new_string: 'x' }))
        .output,
    ).toContain('identical');
    expect(
      await edit(p, { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
    ).toMatchObject({ ok: false, hint: expect.stringContaining('write') });
    const latin = await edit(p, {
      file_path: 'latin1.txt',
      old_string: 'caf',
      new_string: 'tea',
    });
    expect(latin.output).toContain('not UTF-8');
    expect(readFileSync(p.path('latin1.txt'))).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    );
  });

  test('refuses paths outside the root', async () => {
    const p = tempProject();
    const result = await edit(p, {
      file_path: '../outside/x.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(result.output).toContain('outside the project');
  });
});
