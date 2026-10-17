import { describe, expect, test } from 'bun:test';
import {
  applyPick,
  fuzzyFilter,
  fuzzyScore,
  mentionAt,
  pickerFor,
} from '../../src/ui/picker.ts';

const FILES = [
  'src/ui/state.ts',
  'src/ui/status.ts',
  'src/agent/loop.ts',
  'test/ui/state.test.ts',
  'docs/design.md',
  'README.md',
];

describe('fuzzy matching', () => {
  test('matches subsequences, rejects the rest', () => {
    expect(fuzzyScore('sst', 'src/ui/state.ts')).not.toBeNull();
    expect(fuzzyScore('zzz', 'src/ui/state.ts')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  test('file-name and consecutive matches rank first', () => {
    expect(fuzzyFilter('state', FILES)).toEqual([
      'src/ui/state.ts',
      'test/ui/state.test.ts',
    ]);
    expect(fuzzyFilter('stat', FILES).slice(0, 2)).toEqual([
      'src/ui/state.ts',
      'src/ui/status.ts',
    ]);
    expect(fuzzyFilter('loop', FILES)[0]).toBe('src/agent/loop.ts');
    expect(fuzzyFilter('DESIGN', FILES)).toEqual(['docs/design.md']);
  });

  test('caps the list', () => {
    expect(fuzzyFilter('', FILES, 3)).toHaveLength(3);
  });
});

describe('mentionAt', () => {
  test('finds the @word at the cursor', () => {
    expect(mentionAt('fix @src/ui', 11)).toEqual({ start: 4, query: 'src/ui' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
  });

  test('ignores emails and finished mentions', () => {
    expect(mentionAt('mail me@host', 12)).toBeNull();
    expect(mentionAt('@a.ts done', 10)).toBeNull();
  });
});

describe('pickerFor and applyPick', () => {
  test('"/" opens the command list, filtered by prefix', () => {
    const picker = pickerFor('/cl', 3, FILES);
    expect(picker).toMatchObject({
      kind: 'command',
      matches: [{ name: '/clear' }],
    });
    expect(applyPick(picker, 0, '/cl', 3)).toEqual({
      text: '/clear',
      cursor: 6,
    });
  });

  test('"/" followed by a space, or an unknown command, is plain text', () => {
    expect(pickerFor('/clear now', 10, FILES).kind).toBe('none');
    expect(pickerFor('/nope', 5, FILES).kind).toBe('none');
  });

  test('"@" opens the file picker and picking inserts the path', () => {
    const text = 'look at @loop please';
    const picker = pickerFor(text, 13, FILES);
    expect(picker).toMatchObject({
      kind: 'file',
      start: 8,
      matches: ['src/agent/loop.ts'],
    });
    expect(applyPick(picker, 0, text, 13)).toEqual({
      text: 'look at @src/agent/loop.ts  please',
      cursor: 27,
    });
  });

  test('nothing to pick returns null', () => {
    expect(applyPick(pickerFor('@zzz', 4, FILES), 0, '@zzz', 4)).toBeNull();
    expect(applyPick({ kind: 'none' }, 0, '', 0)).toBeNull();
  });
});
