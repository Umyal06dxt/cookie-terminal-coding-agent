import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ProviderError } from '../src/provider/errors.ts';
import type {
  ChatStream,
  ChatStreamParams,
  StreamEvent,
} from '../src/provider/stream.ts';

export interface FakeToolCall {
  name: string;
  /** An object is JSON-encoded; a string is sent verbatim (to fake malformed JSON). */
  args: unknown;
  id?: string;
}

/** One canned reply, written at the level a test cares about. */
export interface FakeTurn {
  /** Streamed as one delta per array item. */
  text?: string | string[];
  toolCalls?: FakeToolCall[];
  /** Defaults to "tool_calls" when there are tool calls, else "stop". */
  finishReason?: string | null;
  usage?: { input: number; output: number; cacheRead?: number };
}

/**
 * A step of a raw turn: a stream event, or a hook run mid-stream (e.g. to abort).
 * After each hook the fake checks the signal and reacts per the turn's `onAbort`.
 */
export type FakeStep =
  | StreamEvent
  | ((signal: AbortSignal | undefined) => void);

export type ScriptedTurn =
  | FakeTurn
  | {
      steps: FakeStep[];
      /**
       * How the stream reacts to an abort. 'end' (default) matches the openai SDK, which
       * returns quietly on a transport abort mid-stream, so streamChat ends with
       * `done { finishReason: null }`. 'throw' matches an abort while the request opens.
       */
      onAbort?: 'end' | 'throw';
    }
  | { fail: ProviderError };

export interface FakeModel extends ChatStream {
  /** What each request sent, with messages deep-copied at call time. */
  requests: {
    model: string;
    messages: ChatCompletionMessageParam[];
    toolNames: string[];
  }[];
  remaining(): number;
}

let callCounter = 0;

/** Expands a FakeTurn into the events src/provider/stream.ts would emit for it. */
export function turnEvents(turn: FakeTurn): StreamEvent[] {
  const events: StreamEvent[] = [];
  const text = typeof turn.text === 'string' ? [turn.text] : (turn.text ?? []);
  for (const piece of text) events.push({ type: 'text_delta', text: piece });

  const calls = (turn.toolCalls ?? []).map((c, index) => ({
    index,
    id: c.id ?? `call_fake_${++callCounter}`,
    name: c.name,
    argsJson:
      typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
  }));
  for (const c of calls) {
    events.push({
      type: 'tool_call_start',
      index: c.index,
      id: c.id,
      name: c.name,
    });
    // Split arguments in two, as real streams fragment them.
    const mid = Math.ceil(c.argsJson.length / 2);
    for (const chunk of [c.argsJson.slice(0, mid), c.argsJson.slice(mid)]) {
      if (chunk !== '')
        events.push({
          type: 'tool_call_delta',
          index: c.index,
          argsChunk: chunk,
        });
    }
  }
  const finishReason =
    turn.finishReason !== undefined
      ? turn.finishReason
      : calls.length > 0
        ? 'tool_calls'
        : 'stop';
  if (finishReason !== null) {
    for (const c of calls) events.push({ type: 'tool_call_end', ...c });
  }
  if (turn.usage) {
    events.push({ type: 'usage', cacheRead: 0, ...turn.usage });
  }
  events.push({ type: 'done', finishReason });
  return events;
}

/** A scripted stand-in for streamChat: replays `script` one turn per request. */
export function fakeModel(script: ScriptedTurn[]): FakeModel {
  const queue = [...script];

  const stream = (params: ChatStreamParams): AsyncIterable<StreamEvent> => {
    stream.requests.push({
      model: params.model,
      messages: structuredClone(params.messages),
      toolNames: (params.tools ?? []).flatMap((t) =>
        t.type === 'function' ? [t.function.name] : [],
      ),
    });
    const turn = queue.shift();
    const { signal } = params;

    return (async function* () {
      if (turn === undefined)
        throw new Error('fakeModel: the script ran out of turns');
      if ('fail' in turn) throw turn.fail;
      const steps: FakeStep[] = 'steps' in turn ? turn.steps : turnEvents(turn);
      const onAbort = 'steps' in turn ? (turn.onAbort ?? 'end') : 'end';
      for (const step of steps) {
        if (typeof step === 'function') step(signal);
        if (signal?.aborted) {
          if (onAbort === 'throw') throw new ProviderError('aborted');
          yield { type: 'done', finishReason: null };
          return;
        }
        if (typeof step === 'function') continue;
        // Yield to the event loop so it behaves like a real network stream.
        await Promise.resolve();
        yield step;
      }
    })();
  };
  stream.requests = [] as FakeModel['requests'];
  stream.remaining = () => queue.length;
  return stream;
}
