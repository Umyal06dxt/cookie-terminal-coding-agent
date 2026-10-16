import { describe, expect, test } from 'bun:test';
import { CONTINUE_PROMPT } from '../../src/agent/loop.ts';
import { LOOP_STOPPED } from '../../src/agent/run-tools.ts';
import { ProviderError } from '../../src/provider/errors.ts';
import { of, run, tool } from './helpers.ts';

describe('runAgent', () => {
  test('plain answer: streams text and finishes', async () => {
    const { reason, session, events, model, end } = await run(
      [
        {
          text: ['Golden', ' and crisp.'],
          usage: { input: 50, output: 4, cacheRead: 40 },
        },
      ],
      [tool('read')],
    );
    expect(reason).toBe('done');
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Golden and crisp.',
    });
    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
      'usage',
      'turn_end',
      'agent_end',
    ]);
    expect(session.totals).toEqual({ input: 50, output: 4, cacheRead: 40 });
    expect(model.requests[0]?.toolNames).toEqual(['read']);
    expect(end.summary).toBe('Finished in 1 turn.');
  });

  test('one tool call, then an answer', async () => {
    const read = tool('read', () => ({
      ok: true,
      content: 'flour, butter, sugar',
      summary: '3 lines',
    }));
    const { reason, session, events, model } = await run(
      [
        {
          text: 'Let me check.',
          toolCalls: [{ id: 'c1', name: 'read', args: { path: 'recipe.md' } }],
        },
        { text: 'It needs flour, butter and sugar.' },
      ],
      [read],
    );
    expect(reason).toBe('done');
    expect(read.calls).toEqual([{ path: 'recipe.md' }]);
    expect(session.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"recipe.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'flour, butter, sugar' },
      { role: 'assistant', content: 'It needs flour, butter and sugar.' },
    ]);
    // The second request carries the tool result.
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'flour, butter, sugar',
    });
    expect(of(events, 'tool_call')).toEqual([
      {
        type: 'tool_call',
        id: 'c1',
        name: 'read',
        args: { path: 'recipe.md' },
      },
    ]);
    const [result] = of(events, 'tool_result');
    expect(result).toMatchObject({
      id: 'c1',
      name: 'read',
      ok: true,
      summary: '3 lines',
    });
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('two tool calls in one turn run in order, one tool message each', async () => {
    const order: string[] = [];
    const read = tool('read', (args) => {
      order.push(`read ${JSON.stringify(args)}`);
      return { ok: true, content: 'contents' };
    });
    const grep = tool('grep', () => {
      order.push('grep');
      return { ok: true, content: '2 hits' };
    });
    const { session } = await run(
      [
        {
          toolCalls: [
            { id: 'a', name: 'read', args: { path: 'a.ts' } },
            { id: 'b', name: 'grep', args: { pattern: 'oven' } },
          ],
        },
        { text: 'Done.' },
      ],
      [read, grep],
    );
    expect(order).toEqual(['read {"path":"a.ts"}', 'grep']);
    const toolMessages = session.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toEqual([
      { role: 'tool', tool_call_id: 'a', content: 'contents' },
      { role: 'tool', tool_call_id: 'b', content: '2 hits' },
    ]);
    // An assistant message with only tool calls has null content.
    expect(session.messages[1]).toMatchObject({
      role: 'assistant',
      content: null,
    });
  });

  test('a tool that throws becomes a result the model can recover from', async () => {
    const boom = tool('bash', () => {
      throw new Error('disk on fire');
    });
    const { reason, session, events } = await run(
      [
        { toolCalls: [{ id: 'x', name: 'bash', args: { cmd: 'ls' } }] },
        { text: 'Recovered.' },
      ],
      [boom],
    );
    expect(reason).toBe('done');
    const result = session.messages.find((m) => m.role === 'tool');
    expect(result?.content).toBe(
      'The bash tool crashed: disk on fire. Check the arguments, or try a different approach.',
    );
    expect(String(result?.content)).not.toMatch(/^Error:/);
    expect(of(events, 'tool_result')[0]).toMatchObject({ ok: false });
  });

  test('unknown tools and malformed JSON arguments are answered, not fatal', async () => {
    const { session } = await run(
      [
        {
          toolCalls: [
            { id: 'u', name: 'teleport', args: {} },
            { id: 'j', name: 'read', args: '{"path": "a.ts"' },
          ],
        },
        { text: 'ok' },
      ],
      [tool('read')],
    );
    const [unknown, malformed] = session.messages.filter(
      (m) => m.role === 'tool',
    );
    expect(unknown?.content).toBe(
      'There is no tool named "teleport". Available tools: read. Call one of those instead.',
    );
    expect(String(malformed?.content)).toStartWith(
      'The arguments for read were not valid JSON',
    );
  });

  test('finish_reason "length" keeps the partial reply and asks the model to continue', async () => {
    const { reason, session, model } = await run([
      { text: 'Step one: cream the butter', finishReason: 'length' },
      { text: ' with the sugar.' },
    ]);
    expect(reason).toBe('done');
    expect(session.messages.slice(1)).toEqual([
      { role: 'assistant', content: 'Step one: cream the butter' },
      { role: 'user', content: CONTINUE_PROMPT },
      { role: 'assistant', content: ' with the sugar.' },
    ]);
    expect(model.requests).toHaveLength(2);
  });

  test('a tool call cut off by "length" is dropped, never run, and re-requested', async () => {
    const read = tool('read');
    const { session } = await run(
      [
        {
          text: 'Reading',
          toolCalls: [{ name: 'read', args: '{"path": "src/' }],
          finishReason: 'length',
        },
        { text: 'ok' },
      ],
      [read],
    );
    expect(read.calls).toEqual([]);
    expect(
      session.messages.some((m) => m.role === 'assistant' && m.tool_calls),
    ).toBe(false);
    expect(session.messages[2]).toEqual({
      role: 'user',
      content: expect.stringContaining('send it again in full'),
    });
  });

  test('stops at max_turns with a summary', async () => {
    const read = tool('read');
    const script = [1, 2, 3, 4].map((n) => ({
      text: `Reading part ${n}.`,
      toolCalls: [{ name: 'read', args: { offset: n } }],
    }));
    const { reason, end, model, session } = await run(script, [read], {
      maxTurns: 3,
    });
    expect(reason).toBe('max_turns');
    expect(model.requests).toHaveLength(3);
    expect(read.calls).toHaveLength(3);
    expect(end).toMatchObject({ reason: 'max_turns', turns: 3 });
    expect(end.summary).toContain('max_turns');
    expect(end.summary).toContain('read ×3');
    expect(end.summary).toContain('Reading part 3.');
    expect(session.messages.at(-1)?.role).toBe('tool');
  });

  test('the same call with identical args 3 times in a row stops the loop', async () => {
    const read = tool('read');
    const same = (args: unknown) => ({ toolCalls: [{ name: 'read', args }] });
    const { reason, events, session, model } = await run(
      // Key order differs on the third call; it is still the same call.
      [
        same({ path: 'a', limit: 5 }),
        same({ path: 'a', limit: 5 }),
        same({ limit: 5, path: 'a' }),
        { text: 'unreached' },
      ],
      [read],
    );
    expect(reason).toBe('error');
    expect(read.calls).toHaveLength(2);
    expect(session.messages.at(-1)).toMatchObject({
      role: 'tool',
      content: LOOP_STOPPED,
    });
    expect(of(events, 'error')[0]?.message).toContain(
      'same tool call 3 times in a row',
    );
    expect(model.remaining()).toBe(1);
  });

  test('a different call in between resets the loop count', async () => {
    const read = tool('read');
    const call = (path: string) => ({
      toolCalls: [{ name: 'read', args: { path } }],
    });
    const { reason } = await run(
      [call('a'), call('a'), call('b'), call('a'), call('a'), { text: 'fine' }],
      [read],
    );
    expect(reason).toBe('done');
    expect(read.calls).toHaveLength(5);
  });

  test('a provider error midway keeps the partial text and ends with an error event', async () => {
    const { reason, events, session } = await run([
      {
        steps: [
          { type: 'text_delta', text: 'Preheating' },
          () => {
            throw new ProviderError('upstream', { detail: 'gateway reset' });
          },
        ],
      },
    ]);
    expect(reason).toBe('error');
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'Preheating',
    });
    expect(of(events, 'error')[0]?.message).toContain('gateway reset');
  });
});
