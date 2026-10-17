import { describe, expect, test } from 'bun:test';
import { renderTranscript, viewport } from '../../src/ui/transcript.ts';
import { stateAfter, texts, widest } from './helpers.ts';

describe('renderTranscript', () => {
  const state = stateAfter([
    { type: 'text_delta', text: 'Reading **two** files.' },
    { type: 'tool_call', id: 'a', name: 'read', args: { file_path: 'a.ts' } },
    { type: 'tool_call', id: 'b', name: 'glob', args: { pattern: '**/*.ts' } },
    {
      type: 'tool_result',
      id: 'a',
      name: 'read',
      ok: true,
      summary: '3 lines',
      durationMs: 10,
    },
    {
      type: 'agent_end',
      reason: 'interrupted',
      turns: 1,
      summary: 'Interrupted by user after 1 turn.',
    },
  ]);

  test('user, assistant, stacked tool cards and a notice', () => {
    const rows = texts(renderTranscript(state.items, 50));
    expect(rows).toEqual([
      ' › hi',
      '',
      '  Reading two files.',
      '',
      '  ▸ Read  a.ts                      3 lines  0.01s',
      '  ▸ Glob  **/*.ts                                …',
      '',
      '  · Interrupted by user after 1 turn.',
    ]);
  });

  test('nothing is wider than the terminal', () => {
    expect(widest(renderTranscript(state.items, 24))).toBeLessThanOrEqual(24);
  });

  test('multiline user messages keep their lines', () => {
    const s = stateAfter([]);
    const rows = renderTranscript(
      [{ kind: 'user', key: 'u', text: 'one\ntwo' }, ...s.items.slice(1)],
      20,
    );
    expect(texts(rows)).toEqual([' › one', '   two']);
  });

  test('rows are cached per item: an unchanged item renders to the same rows', () => {
    const first = renderTranscript(state.items, 50);
    const second = renderTranscript(state.items, 50);
    expect(second[0]).toBe(first[0]);
  });
});

describe('viewport', () => {
  const rows = Array.from({ length: 10 }, (_, i) => [{ text: `${i}` }]);

  test('shows the newest rows that fit', () => {
    expect(texts(viewport(rows, 3).rows)).toEqual(['7', '8', '9']);
  });

  test('scrolls up and clamps', () => {
    expect(texts(viewport(rows, 3, 2).rows)).toEqual(['5', '6', '7']);
    expect(viewport(rows, 3, 99)).toMatchObject({ scroll: 7 });
    expect(texts(viewport(rows, 20).rows)).toHaveLength(10);
  });
});
