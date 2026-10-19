import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRecorder,
  createSseParser,
  fileSink,
  loadRecording,
  type RecordingRecord,
  redactChunks,
  safeName,
} from '../../scripts/lib/recording.ts';
import { createClient, type FetchLike } from '../../src/provider/client.ts';
import { type StreamEvent, streamChat } from '../../src/provider/stream.ts';
import { REDACTED } from '../../src/storage/redact.ts';
import {
  errorResponse,
  fakeFetch,
  type Reply,
  readFixture,
  sseResponse,
} from '../fake-fetch.ts';
import { replayModel } from '../replay-model.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';

cleanUpTempProjects();

const SENTINEL = 'sentinel-key-do-not-record-0123456789';
const PROVIDER = {
  base_url: 'https://api.example.test/provider/v1',
  api_key_env: 'COMMANDCODE_API_KEY',
};

function client(fetch: FetchLike | undefined) {
  const made = createClient(PROVIDER, {
    env: { COMMANDCODE_API_KEY: SENTINEL },
    ...(fetch && { fetch }),
  });
  if (!made.ok) throw new Error(made.message);
  return made.client;
}

async function events(fetch: FetchLike | undefined): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of streamChat({
    client: client(fetch),
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    retry: { maxAttempts: 1 },
  })) {
    out.push(e);
  }
  return out;
}

/** An SSE body from chunk objects. */
const sse = (chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

const textChunk = (content: string) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
});
const argsChunk = (args: string, first = false) => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index: 0,
            ...(first && { id: 'c1', type: 'function' }),
            function: { ...(first && { name: 'bash' }), arguments: args },
          },
        ],
      },
      finish_reason: null,
    },
  ],
});
const finish = {
  choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
};

describe('createSseParser', () => {
  test('handles any split: mid-line, between \\r and \\n, right before [DONE]', () => {
    const body =
      'data: {"a":1}\r\n\r\n: comment\n\ndata: {"b":\ndata: 2}\n\ndata: [DONE]\n\n';
    for (let size = 1; size <= body.length; size++) {
      const got: string[] = [];
      const parser = createSseParser((d) => got.push(d));
      for (let i = 0; i < body.length; i += size)
        parser.push(body.slice(i, i + size));
      parser.end();
      expect(got).toEqual(['{"a":1}', '{"b":\n2}', '[DONE]']);
    }
  });
});

describe('createRecorder', () => {
  test('the caller sees exactly the same stream with the recorder in front', async () => {
    const body = readFixture('stream', 'single-tool-call.txt');
    const plain = await events(fakeFetch([sseResponse(body)]));
    const records: RecordingRecord[] = [];
    const recorder = createRecorder((r) => records.push(r));
    const recorded = await events(
      recorder.fetch(fakeFetch([sseResponse(body)])),
    );
    await recorder.settled();
    expect(recorded).toEqual(plain);
    expect(records.map((r) => r.t)).toEqual([
      'request',
      'response',
      'chunk',
      'chunk',
      'chunk',
      'chunk',
      'chunk',
      'chunk',
      'done',
    ]);
  });

  test('stores header names only: the API key never reaches the recording', async () => {
    const p = tempProject();
    const file = join(p.root, 'r.jsonl');
    const recorder = createRecorder(fileSink(file));
    await events(
      recorder.fetch(
        fakeFetch([sseResponse(readFixture('stream', 'plain-text.txt'))]),
      ),
    );
    await recorder.settled();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(SENTINEL);
    const request = loadRecording(file).find((r) => r.t === 'request');
    expect(request).toMatchObject({
      method: 'POST',
      path: '/provider/v1/chat/completions',
    });
    expect(request?.t === 'request' && request.headers).toContain(
      'authorization',
    );
    expect(request?.t === 'request' && request.body).toMatchObject({
      model: 'm',
      stream: true,
    });
  });

  test('a secret split across chunks is redacted whole, and the file still parses', async () => {
    const p = tempProject();
    const file = join(p.root, 'r.jsonl');
    const recorder = createRecorder(fileSink(file));
    const body = sse([
      textChunk('Your key is sk-proj-'),
      textChunk('Abc123def456GHI789jkl012. '),
      argsChunk('{"command":"curl -H \\"Authorization: Bearer abcd', true),
      argsChunk('efgh12345678ijkl\\" x"}'),
      finish,
    ]);
    const seen = await events(recorder.fetch(fakeFetch([sseResponse(body)])));
    await recorder.settled();
    // The caller got the real stream; only the recording is redacted.
    expect(seen.find((e) => e.type === 'text_delta')).toMatchObject({
      text: 'Your key is sk-proj-',
    });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('Abc123def456');
    expect(raw).not.toContain('efgh12345678');
    const records = loadRecording(file);
    expect(records.some((r) => r.t === 'redacted')).toBe(true);
    const texts = records.flatMap((r) =>
      r.t === 'chunk'
        ? [
            (r.chunk as ReturnType<typeof textChunk>).choices[0]?.delta
              .content ?? '',
          ]
        : [],
    );
    expect(texts.join('')).toBe(`Your key is ${REDACTED}. `);
  });

  test('error responses are recorded with their status and body', async () => {
    const records: RecordingRecord[] = [];
    const recorder = createRecorder((r) => records.push(r));
    await expect(
      events(
        recorder.fetch(
          fakeFetch([errorResponse(429, 'rate_limited', 'Too many requests')]),
        ),
      ),
    ).rejects.toThrow();
    await recorder.settled();
    expect(records.find((r) => r.t === 'response')).toMatchObject({
      status: 429,
    });
    expect(records.find((r) => r.t === 'error')).toMatchObject({
      body: { error: { code: 'rate_limited' } },
    });
  });

  test('requests that are not chat completions pass through unrecorded', async () => {
    const records: RecordingRecord[] = [];
    const recorder = createRecorder((r) => records.push(r));
    const inner = fakeFetch([new Response('{"data":[]}')]);
    await recorder.fetch(inner)('https://api.example.test/provider/v1/models');
    expect(records).toEqual([]);
    expect(inner.requests).toHaveLength(1);
  });
});

describe('redactChunks', () => {
  test('clean chunks come back unchanged', () => {
    const chunks = [textChunk('hello '), textChunk('world')];
    expect(redactChunks(chunks)).toEqual({ chunks, changed: false });
  });

  test('tool arguments are reassembled per call before redacting', () => {
    const { chunks, changed } = redactChunks([
      argsChunk('{"command":"export TOKEN=', true),
      argsChunk('supersecret99"}'),
      finish,
    ]);
    expect(changed).toBe(true);
    const args = chunks.map(
      (c) =>
        (c as ReturnType<typeof argsChunk>).choices[0]?.delta.tool_calls?.[0]
          ?.function.arguments ?? '',
    );
    expect(args.join('')).toBe(`{"command":"export TOKEN=${REDACTED}"}`);
  });
});

test('safeName keeps model ids readable and paths safe', () => {
  expect(safeName('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash');
  expect(safeName('Fix the café test!')).toBe('fix-the-cafe-test');
  expect(safeName('../../etc')).toBe('etc');
});

describe('recording → replay fidelity', () => {
  const PARAMS = {
    model: 'm',
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  /** Events and the error kind (if any) from a stream. */
  async function drain(stream: AsyncIterable<StreamEvent>) {
    const seen: StreamEvent[] = [];
    try {
      for await (const e of stream) seen.push(e);
      return { seen, error: null };
    } catch (error) {
      const e = error as { kind?: string; detail?: string };
      return { seen, error: { kind: e.kind, detail: e.detail } };
    }
  }

  /** `make` builds fresh replies each time: a Response body can only be read once. */
  async function liveAndReplay(make: () => Reply[], maxAttempts = 1) {
    const retry = { maxAttempts, sleep: async () => {} };
    const live = await drain(
      streamChat({ client: client(fakeFetch(make())), ...PARAMS, retry }),
    );
    const records: RecordingRecord[] = [];
    const recorder = createRecorder((r) => records.push(r));
    await drain(
      streamChat({
        client: client(recorder.fetch(fakeFetch(make()))),
        ...PARAMS,
        retry,
      }),
    );
    await recorder.settled();
    const model = replayModel(records, { onMismatch: 'collect' });
    const replayed = await drain(model(PARAMS));
    expect(model.mismatches).toEqual([]);
    return { live, replayed, records };
  }

  test('a provider error mid-stream replays as the same events, then the same error', async () => {
    const { live, replayed } = await liveAndReplay(() => [
      sseResponse(readFixture('stream', 'upstream-error-midway.txt')),
    ]);
    expect(live.error).toMatchObject({
      kind: 'upstream',
      detail: 'upstream provider closed the connection',
    });
    expect(replayed).toEqual(live);
  });

  test('a retried attempt is recorded, and replay uses only the attempt the loop saw', async () => {
    const { live, replayed, records } = await liveAndReplay(
      () => [
        errorResponse(429, 'rate_limited', 'slow down'),
        sseResponse(readFixture('stream', 'plain-text.txt')),
      ],
      2,
    );
    const bodies = records.flatMap((r) =>
      r.t === 'request' ? [JSON.stringify(r.body)] : [],
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(live.error).toBeNull();
    expect(replayed).toEqual(live);
  });

  test('a network failure is recorded with its kind and replays as the same error', async () => {
    const { live, replayed, records } = await liveAndReplay(() => [
      new TypeError('fetch failed'),
    ]);
    expect(records.find((r) => r.t === 'failure')).toMatchObject({
      kind: 'network',
      message: 'fetch failed',
    });
    expect(live.error?.kind).toBe('network');
    expect(replayed.error?.kind).toBe('network');
  });
});
