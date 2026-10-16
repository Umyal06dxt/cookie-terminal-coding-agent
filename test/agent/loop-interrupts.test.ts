import { describe, expect, test } from 'bun:test';
import {
  INTERRUPTED_BEFORE,
  INTERRUPTED_DURING,
} from '../../src/agent/run-tools.ts';
import { of, run, tool } from './helpers.ts';

describe('runAgent interrupts', () => {
  test.each(['end', 'throw'] as const)(
    'abort mid-stream (stream reacts by %s) keeps the partial text and a valid history',
    async (onAbort) => {
      const controller = new AbortController();
      const read = tool('read');
      const { reason, session, end } = await run(
        [
          { toolCalls: [{ id: 'r1', name: 'read', args: { path: 'a' } }] },
          {
            steps: [
              { type: 'text_delta', text: 'The file says' },
              () => controller.abort(),
              { type: 'text_delta', text: ' never seen' },
            ],
            onAbort,
          },
        ],
        [read],
        { signal: controller.signal },
      );
      expect(reason).toBe('interrupted');
      expect(session.messages.at(-1)).toEqual({
        role: 'assistant',
        content: 'The file says',
      });
      expect(end.summary).toContain('Interrupted by user');
    },
  );

  test('abort after tool calls streamed but before they ran answers every call', async () => {
    const controller = new AbortController();
    const read = tool('read');
    const { reason, session } = await run(
      [
        {
          steps: [
            { type: 'tool_call_start', index: 0, id: 'p', name: 'read' },
            {
              type: 'tool_call_end',
              index: 0,
              id: 'p',
              name: 'read',
              argsJson: '{}',
            },
            { type: 'tool_call_start', index: 1, id: 'q', name: 'read' },
            {
              type: 'tool_call_end',
              index: 1,
              id: 'q',
              name: 'read',
              argsJson: '{}',
            },
            () => controller.abort(),
            { type: 'done', finishReason: 'tool_calls' },
          ],
          onAbort: 'throw',
        },
      ],
      [read],
      { signal: controller.signal },
    );
    expect(reason).toBe('interrupted');
    expect(read.calls).toEqual([]);
    expect(
      session.messages.filter((m) => m.role === 'tool').map((m) => m.content),
    ).toEqual([INTERRUPTED_BEFORE, INTERRUPTED_BEFORE]);
  });

  test('a stream that ends quietly on abort still answers the calls it finished', async () => {
    const controller = new AbortController();
    const read = tool('read');
    const { reason, session, events } = await run(
      [
        {
          steps: [
            { type: 'text_delta', text: 'Reading.' },
            { type: 'tool_call_start', index: 0, id: 'z', name: 'read' },
            {
              type: 'tool_call_end',
              index: 0,
              id: 'z',
              name: 'read',
              argsJson: '{}',
            },
            () => controller.abort(),
          ],
        },
      ],
      [read],
      { signal: controller.signal },
    );
    expect(reason).toBe('interrupted');
    expect(read.calls).toEqual([]);
    expect(session.messages.slice(-2)).toMatchObject([
      { role: 'assistant', content: 'Reading.' },
      { role: 'tool', tool_call_id: 'z', content: INTERRUPTED_BEFORE },
    ]);
    // The UI and log see the call and its outcome even though it never ran.
    expect(of(events, 'tool_call').map((e) => e.id)).toEqual(['z']);
    expect(of(events, 'tool_result')).toMatchObject([
      { id: 'z', ok: false, durationMs: 0 },
    ]);
  });

  test('abort while a tool runs: that call is marked interrupted, later ones never run', async () => {
    const controller = new AbortController();
    const slow = tool('bash', (_args, signal) => {
      controller.abort();
      throw new Error(signal.aborted ? 'killed' : 'unexpected');
    });
    const read = tool('read');
    const { reason, session, events } = await run(
      [
        {
          toolCalls: [
            { name: 'bash', args: { cmd: 'sleep 99' } },
            { name: 'read', args: {} },
          ],
        },
        { text: 'unreached' },
      ],
      [slow, read],
      { signal: controller.signal },
    );
    expect(reason).toBe('interrupted');
    expect(read.calls).toEqual([]);
    expect(
      session.messages.filter((m) => m.role === 'tool').map((m) => m.content),
    ).toEqual([INTERRUPTED_DURING, INTERRUPTED_BEFORE]);
    expect(of(events, 'tool_result').map((e) => e.ok)).toEqual([false, false]);
  });

  test('an already-aborted signal never calls the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const { reason, model } = await run([{ text: 'unreached' }], [], {
      signal: controller.signal,
    });
    expect(reason).toBe('interrupted');
    expect(model.requests).toHaveLength(0);
  });
});
