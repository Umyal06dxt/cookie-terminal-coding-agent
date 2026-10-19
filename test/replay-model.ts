import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { RecordingRecord } from '../scripts/lib/recording.ts';
import {
  fromHttp,
  ProviderError,
  type ProviderErrorKind,
} from '../src/provider/errors.ts';
import {
  accumulateChunks,
  type ChatStreamParams,
  type StreamEvent,
} from '../src/provider/stream.ts';
import { redactDeep } from '../src/storage/redact.ts';

export interface ReplayOptions {
  /** Also compare the system prompt (it holds the date, OS and paths, so off by default). */
  compareSystem?: boolean;
  /** Also compare tool results (they depend on the file system, so off by default). */
  compareToolResults?: boolean;
  /**
   * 'reject' (default) raises an unhandled rejection, which fails the running test even though
   * the agent loop catches stream errors. 'collect' only records it, for testing the replay.
   */
  onMismatch?: 'reject' | 'collect';
}

interface Exchange {
  n: number;
  body: unknown;
  status: number;
  chunks: unknown[];
  error: unknown;
  /** A failure without a status (network, timeout, abort), or a stream that broke midway. */
  failure: { kind: ProviderErrorKind; message: string } | null;
  responded: boolean;
}

export interface ReplayModel {
  (params: ChatStreamParams): AsyncIterable<StreamEvent>;
  /** Divergences found so far, one message each. */
  mismatches: string[];
  /** Recorded requests the loop has not sent yet. */
  remaining(): number;
  /** Throws unless every recorded request was sent and matched: a loop that stops early fails too. */
  assertDone(): void;
}

function exchanges(records: readonly RecordingRecord[]): Exchange[] {
  const byN = new Map<number, Exchange>();
  const get = (n: number) => {
    let ex = byN.get(n);
    if (!ex) {
      ex = {
        n,
        body: null,
        status: 200,
        chunks: [],
        error: null,
        failure: null,
        responded: false,
      };
      byN.set(n, ex);
    }
    return ex;
  };
  for (const r of records) {
    if (r.t === 'request') get(r.n).body = r.body;
    else if (r.t === 'response') {
      get(r.n).status = r.status;
      get(r.n).responded = true;
    } else if (r.t === 'chunk') get(r.n).chunks.push(r.chunk);
    else if (r.t === 'error') get(r.n).error = r.body;
    else if (r.t === 'failure')
      get(r.n).failure = { kind: r.kind, message: r.message };
  }
  const ordered = [...byN.values()].sort((a, b) => a.n - b.n);
  // A failed attempt followed by the same request is the provider layer retrying; the loop only
  // ever sees the final attempt, so that is the one to replay.
  return ordered.filter((ex, i) => {
    const next = ordered[i + 1];
    const failed = ex.status >= 400 || !ex.responded;
    return !(
      failed &&
      next !== undefined &&
      JSON.stringify(next.body) === JSON.stringify(ex.body)
    );
  });
}

/** The parts of a message the replay holds the loop to. */
function shape(message: unknown, options: ReplayOptions): unknown {
  const m = (message ?? {}) as Record<string, unknown>;
  switch (m.role) {
    case 'system':
      return {
        role: 'system',
        ...(options.compareSystem && { content: m.content }),
      };
    case 'tool':
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id,
        ...(options.compareToolResults && { content: m.content }),
      };
    case 'assistant': {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      return {
        role: 'assistant',
        content: m.content === '' ? null : (m.content ?? null),
        tool_calls: calls.map((c) => {
          const call = c as {
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          };
          return {
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments,
          };
        }),
      };
    }
    default:
      return { role: m.role, content: m.content };
  }
}

const clip = (v: unknown) => {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
};

/** Every difference between two JSON values, as "path: expected X, got Y". */
function diff(
  expected: unknown,
  actual: unknown,
  path: string,
  out: string[],
): void {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  const bothObjects =
    typeof expected === 'object' &&
    expected !== null &&
    typeof actual === 'object' &&
    actual !== null;
  if (!bothObjects || Array.isArray(expected) !== Array.isArray(actual)) {
    out.push(`${path}: expected ${clip(expected)}, got ${clip(actual)}`);
    return;
  }
  const e = expected as Record<string, unknown>;
  const a = actual as Record<string, unknown>;
  for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
    diff(
      e[key],
      a[key],
      Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`,
      out,
    );
  }
}

/** What differs between the recorded request and the one the loop just sent. */
export function compareRequest(
  recorded: unknown,
  params: ChatStreamParams,
  options: ReplayOptions = {},
): string[] {
  const body = (recorded ?? {}) as {
    model?: unknown;
    messages?: unknown[];
    tools?: unknown[];
  };
  const toolNames = (tools: unknown[] | undefined) =>
    (tools ?? []).map(
      (t) => (t as { function?: { name?: unknown } }).function?.name,
    );
  // The recording was redacted, so the live request is too before comparing.
  const sent = redactDeep(
    structuredClone(params.messages),
  ) as ChatCompletionMessageParam[];
  const out: string[] = [];
  diff(body.model, params.model, 'model', out);
  diff(toolNames(body.tools), toolNames(params.tools), 'tools', out);
  diff(
    (body.messages ?? []).map((m) => shape(m, options)),
    sent.map((m) => shape(m, options)),
    'messages',
    out,
  );
  return out;
}

/**
 * Recorded chunks as a stream. An `{"error": …}` payload is how a provider fails mid-stream;
 * the SDK throws there, so this does too, as toProviderError would report it.
 */
async function* fromArray(
  chunks: unknown[],
): AsyncIterable<ChatCompletionChunk> {
  for (const chunk of chunks) {
    await Promise.resolve(); // Like a network stream: one chunk per tick.
    const error = (chunk as { error?: { message?: unknown } | null }).error;
    if (error !== undefined && error !== null) {
      const message = error.message;
      throw new ProviderError('upstream', {
        ...(typeof message === 'string' && { detail: message.slice(0, 300) }),
      });
    }
    yield chunk as ChatCompletionChunk;
  }
}

/**
 * A stand-in for streamChat that replays a recording turn by turn through the real chunk
 * parser. Each request the loop sends is checked against the recorded one; a request the
 * recording didn't expect (different, or one too many) fails the test loudly.
 */
export function replayModel(
  records: readonly RecordingRecord[],
  options: ReplayOptions = {},
): ReplayModel {
  const queue = exchanges(records);
  let sent = 0;

  const mismatches: string[] = [];

  const mismatch = (message: string): Error => {
    const error = new Error(`replayModel: ${message}`);
    mismatches.push(error.message);
    if ((options.onMismatch ?? 'reject') === 'reject')
      void Promise.reject(error);
    return error;
  };

  const stream = (params: ChatStreamParams): AsyncIterable<StreamEvent> => {
    sent++;
    const exchange = queue.shift();
    return (async function* () {
      if (!exchange) {
        throw mismatch(
          `the loop sent request #${sent}, but the recording has only ${sent - 1}.`,
        );
      }
      const differences = compareRequest(exchange.body, params, options);
      if (differences.length > 0) {
        throw mismatch(
          `request #${sent} differs from the recording:\n  ${differences.join('\n  ')}`,
        );
      }
      const { failure } = exchange;
      if (failure && !exchange.responded) {
        throw new ProviderError(failure.kind, { detail: failure.message });
      }
      if (exchange.status >= 400)
        throw fromHttp(exchange.status, exchange.error);
      yield* accumulateChunks(fromArray(exchange.chunks));
      if (failure)
        throw new ProviderError(failure.kind, { detail: failure.message });
    })();
  };

  const model: ReplayModel = Object.assign(stream, {
    mismatches,
    remaining: () => queue.length,
    assertDone: () => {
      if (mismatches.length > 0) throw new Error(mismatches.join('\n'));
      if (queue.length > 0) {
        throw new Error(
          `replayModel: the loop stopped after ${sent} request(s); the recording has ${sent + queue.length}.`,
        );
      }
    },
  });
  return model;
}
