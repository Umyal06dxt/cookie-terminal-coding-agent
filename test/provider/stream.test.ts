import { describe, expect, test } from 'bun:test';
import { ProviderError } from '../../src/provider/errors.ts';
import { type StreamEvent, streamChat } from '../../src/provider/stream.ts';
import {
  errorResponse,
  fakeFetch,
  readFixture,
  sseResponse,
  testClient,
} from '../fake-fetch.ts';

async function collect(fixture: string, tools = true): Promise<StreamEvent[]> {
  const fetch = fakeFetch([sseResponse(readFixture('stream', fixture))]);
  const events: StreamEvent[] = [];
  for await (const event of streamChat({
    client: testClient(fetch),
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    ...(tools && {
      tools: [
        {
          type: 'function',
          function: { name: 'read', parameters: { type: 'object' } },
        },
      ],
    }),
  })) {
    events.push(event);
  }
  return events;
}

describe('streamChat', () => {
  test('plain text arrives as deltas, then usage and done', async () => {
    const events = await collect('plain-text.txt', false);
    const text = events
      .flatMap((e) => (e.type === 'text_delta' ? [e.text] : []))
      .join('');
    expect(text).toBe('Fresh out of the oven 🍪');
    expect(events.filter((e) => e.type.startsWith('tool_call'))).toEqual([]);
    expect(events.slice(-2)).toEqual([
      { type: 'usage', input: 42, output: 7, cacheRead: 32 },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  test('one tool call split across 4 chunks is stitched back together', async () => {
    const events = await collect('single-tool-call.txt');
    expect(events).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_read_01', name: 'read' },
      { type: 'tool_call_delta', index: 0, argsChunk: '{"path": ' },
      { type: 'tool_call_delta', index: 0, argsChunk: '"src/cli' },
      { type: 'tool_call_delta', index: 0, argsChunk: '.ts", "limit": 40}' },
      {
        type: 'tool_call_end',
        index: 0,
        id: 'call_read_01',
        name: 'read',
        argsJson: '{"path": "src/cli.ts", "limit": 40}',
      },
      // DeepSeek reports cache hits as prompt_cache_hit_tokens.
      { type: 'usage', input: 1200, output: 24, cacheRead: 1152 },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
    const end = events.find((e) => e.type === 'tool_call_end');
    expect(end?.type === 'tool_call_end' && JSON.parse(end.argsJson)).toEqual({
      path: 'src/cli.ts',
      limit: 40,
    });
  });

  test('two interleaved parallel tool calls are kept apart by index', async () => {
    const events = await collect('parallel-tool-calls.txt');
    expect(events[0]).toEqual({
      type: 'text_delta',
      text: 'Checking both files.',
    });
    expect(events.filter((e) => e.type === 'tool_call_start')).toEqual([
      { type: 'tool_call_start', index: 0, id: 'call_grep_a', name: 'grep' },
      { type: 'tool_call_start', index: 1, id: 'call_read_b', name: 'read' },
    ]);
    const ends = events.filter((e) => e.type === 'tool_call_end');
    expect(ends).toEqual([
      {
        type: 'tool_call_end',
        index: 0,
        id: 'call_grep_a',
        name: 'grep',
        argsJson: '{"pattern":"upload","path":"apps/api"}',
      },
      {
        type: 'tool_call_end',
        index: 1,
        id: 'call_read_b',
        name: 'read',
        argsJson: '{"path":"packages/db/schema.ts"}',
      },
    ]);
    // Deltas for each index add up to that call's final arguments.
    for (const end of ends) {
      if (end.type !== 'tool_call_end') continue;
      const joined = events
        .flatMap((e) =>
          e.type === 'tool_call_delta' && e.index === end.index
            ? [e.argsChunk]
            : [],
        )
        .join('');
      expect(joined).toBe(end.argsJson);
    }
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  test('sends stream options and tools in the request', async () => {
    const fetch = fakeFetch([
      async (request) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          model: 'm',
          stream: true,
          stream_options: { include_usage: true },
        });
        expect(body.tools).toBeUndefined();
        return sseResponse(readFixture('stream', 'plain-text.txt'));
      },
    ]);
    const stream = streamChat({
      client: testClient(fetch),
      model: 'm',
      messages: [],
      tools: [],
    });
    for await (const _ of stream) {
      // drain
    }
    expect(fetch.requests).toHaveLength(1);
  });

  test('retries opening the stream after a 429, then streams', async () => {
    const fetch = fakeFetch([
      errorResponse(429, 'rate_limit_error', 'slow down', {
        'retry-after': '1',
      }),
      sseResponse(readFixture('stream', 'plain-text.txt')),
    ]);
    const waits: number[] = [];
    const events: StreamEvent[] = [];
    for await (const event of streamChat({
      client: testClient(fetch),
      model: 'm',
      messages: [],
      retry: { sleep: async (ms) => void waits.push(ms) },
    })) {
      events.push(event);
    }
    expect(waits).toEqual([1000]);
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'stop' });
  });

  test('a 401 surfaces as a typed auth error without retrying', async () => {
    const fetch = fakeFetch([
      errorResponse(401, 'authentication_error', 'bad key'),
    ]);
    const run = async () => {
      for await (const _ of streamChat({
        client: testClient(fetch),
        model: 'm',
        messages: [],
      })) {
        // drain
      }
    };
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('auth');
    expect(fetch.requests).toHaveLength(1);
  });

  test('an error event midway keeps the partial text and surfaces as upstream', async () => {
    const fetch = fakeFetch([
      sseResponse(readFixture('stream', 'upstream-error-midway.txt')),
    ]);
    const events: StreamEvent[] = [];
    const run = async () => {
      for await (const event of streamChat({
        client: testClient(fetch),
        model: 'minimax-m3',
        messages: [],
      })) {
        events.push(event);
      }
    };
    const error = await run().catch((e: unknown) => e);
    expect(events).toEqual([
      { type: 'text_delta', text: 'Reading the' },
      { type: 'text_delta', text: ' schema now' },
    ]);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('upstream');
    expect((error as ProviderError).detail).toBe(
      'upstream provider closed the connection',
    );
  });
});
