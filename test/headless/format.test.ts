import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../src/agent/events.ts';
import {
  exitCodeFor,
  formatToolLine,
  jsonPrinter,
  TextPrinter,
  toolTarget,
} from '../../src/headless/format.ts';

describe('formatToolLine', () => {
  test('tool, target, summary and seconds on one line', () => {
    expect(
      formatToolLine({
        name: 'read',
        args: { file_path: 'src/math.ts' },
        ok: true,
        summary: '42 lines',
        durationMs: 20,
      }),
    ).toBe('▸ Read src/math.ts 42 lines 0.02s');
  });

  test('a failed call is marked ✗', () => {
    expect(
      formatToolLine({
        name: 'bash',
        args: { command: 'bun test' },
        ok: false,
        summary: 'exit 1',
        durationMs: 1234,
      }),
    ).toBe('✗ Bash bun test exit 1 1.23s');
  });

  test('skips an empty target and summary instead of leaving double spaces', () => {
    expect(
      formatToolLine({
        name: 'x',
        args: 'not json',
        ok: true,
        summary: '',
        durationMs: 0,
      }),
    ).toBe('▸ X 0.00s');
  });
});

describe('toolTarget', () => {
  test('prefers file_path, then pattern, then command', () => {
    expect(toolTarget({ file_path: 'a.ts', pattern: '*.ts' })).toBe('a.ts');
    expect(toolTarget({ pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(toolTarget({ command: 'ls' })).toBe('ls');
  });

  test('missing, empty or non-object args give no target', () => {
    for (const args of [undefined, null, 'raw', 7, {}, { file_path: '' }])
      expect(toolTarget(args)).toBe('');
  });

  test('a long or multi-line command is cut to its first line with …', () => {
    expect(toolTarget({ command: 'echo one\necho two' })).toBe('echo one…');
    const long = toolTarget({ command: 'x'.repeat(200) });
    expect(long).toHaveLength(60);
    expect(long.endsWith('…')).toBe(true);
  });
});

test('exit codes: done 0, max_turns 3, everything else 1', () => {
  expect(exitCodeFor('done')).toBe(0);
  expect(exitCodeFor('max_turns')).toBe(3);
  expect(exitCodeFor('error')).toBe(1);
  expect(exitCodeFor('interrupted')).toBe(1);
  expect(exitCodeFor('budget')).toBe(1);
});

function printer() {
  const out: string[] = [];
  const err: string[] = [];
  const p = new TextPrinter(
    (t) => out.push(t),
    (t) => err.push(t),
  );
  const feed = (...events: AgentEvent[]) => {
    for (const e of events) p.handle(e);
  };
  return { out, err, feed };
}

describe('TextPrinter', () => {
  test('text to stdout; a tool line to stderr ends the stdout line first', () => {
    const { out, err, feed } = printer();
    feed(
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'look.' },
      {
        type: 'tool_call',
        id: 'c1',
        name: 'read',
        args: { file_path: 'a.ts' },
      },
      {
        type: 'tool_result',
        id: 'c1',
        name: 'read',
        ok: true,
        summary: '3 lines',
        durationMs: 10,
      },
      { type: 'turn_end', turn: 1, finishReason: 'tool_calls' },
      { type: 'turn_start', turn: 2 },
      { type: 'text_delta', text: 'Done.\n' },
      { type: 'turn_end', turn: 2, finishReason: 'stop' },
      { type: 'agent_end', reason: 'done', turns: 2, summary: 'Finished.' },
    );
    expect(out.join('')).toBe('Let me look.\nDone.\n');
    expect(err).toEqual(['▸ Read a.ts 3 lines 0.01s\n']);
  });

  test('errors and a non-done ending go to stderr', () => {
    const { out, err, feed } = printer();
    feed(
      { type: 'text_delta', text: 'Hmm' },
      { type: 'error', message: 'The provider is down.' },
      {
        type: 'agent_end',
        reason: 'error',
        turns: 1,
        summary: 'Stopped after 1 turn because of an error.',
      },
    );
    expect(out.join('')).toBe('Hmm\n');
    expect(err).toEqual([
      'cookie: The provider is down.\n',
      'cookie: Stopped after 1 turn because of an error.\n',
    ]);
  });

  test('a run with no text prints nothing to stdout', () => {
    const { out, feed } = printer();
    feed(
      { type: 'turn_start', turn: 1 },
      { type: 'turn_end', turn: 1, finishReason: 'stop' },
      { type: 'agent_end', reason: 'done', turns: 1, summary: '' },
    );
    expect(out).toEqual([]);
  });
});

test('jsonPrinter writes one parseable event per line', () => {
  const out: string[] = [];
  const print = jsonPrinter((t) => out.push(t));
  const event: AgentEvent = { type: 'text_delta', text: 'a\nb' };
  print(event);
  expect(out).toEqual([`${JSON.stringify(event)}\n`]);
  expect(JSON.parse(out[0] ?? '')).toEqual(event);
});
