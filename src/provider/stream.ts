import type OpenAI from 'openai';
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { toProviderError } from './errors.ts';
import { type RetryOptions, withRetry } from './retry.ts';

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsChunk: string }
  | {
      type: 'tool_call_end';
      index: number;
      id: string;
      name: string;
      argsJson: string;
    }
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  /** `finishReason` is null when the stream ended without the model saying why. */
  | { type: 'done'; finishReason: string | null };

interface PendingCall {
  id: string | undefined;
  name: string;
  args: string;
  started: boolean;
}

/** DeepSeek reports cache hits outside the OpenAI field; accept either. */
function cacheReadTokens(
  usage: NonNullable<ChatCompletionChunk['usage']>,
): number {
  const deepseek = (usage as { prompt_cache_hit_tokens?: unknown })
    .prompt_cache_hit_tokens;
  return (
    usage.prompt_tokens_details?.cached_tokens ??
    (typeof deepseek === 'number' ? deepseek : 0)
  );
}

/**
 * Turns raw chunks into typed events. Tool calls arrive as fragments keyed by `index`
 * (the id and name usually only on the first one, possibly interleaved with other calls),
 * so they are stitched together here and closed once the model reports a finish reason.
 */
export async function* accumulateChunks(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<StreamEvent> {
  const calls = new Map<number, PendingCall>();
  let finishReason: string | null = null;

  function* closeCalls(): Generator<StreamEvent> {
    for (const index of [...calls.keys()].sort((a, b) => a - b)) {
      const call = calls.get(index);
      if (!call?.started) continue;
      yield {
        type: 'tool_call_end',
        index,
        id: call.id ?? `call_${index}`,
        name: call.name,
        argsJson: call.args,
      };
    }
    calls.clear();
  }

  for await (const chunk of chunks) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) yield { type: 'text_delta', text: delta.content };

      for (const fragment of delta?.tool_calls ?? []) {
        let call = calls.get(fragment.index);
        if (!call) {
          call = { id: undefined, name: '', args: '', started: false };
          calls.set(fragment.index, call);
        }
        if (fragment.id) call.id = fragment.id;
        // The name comes whole on the first fragment; some providers repeat it later, so ignore those.
        if (fragment.function?.name && !call.started)
          call.name = fragment.function.name;
        const argsChunk = fragment.function?.arguments ?? '';
        call.args += argsChunk;

        if (!call.started && call.name !== '') {
          call.started = true;
          const id = call.id ?? `call_${fragment.index}`;
          yield {
            type: 'tool_call_start',
            index: fragment.index,
            id,
            name: call.name,
          };
          // Arguments that arrived before the name are flushed as one delta.
          if (call.args !== '') {
            yield {
              type: 'tool_call_delta',
              index: fragment.index,
              argsChunk: call.args,
            };
          }
        } else if (call.started && argsChunk !== '') {
          yield { type: 'tool_call_delta', index: fragment.index, argsChunk };
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        yield* closeCalls();
      }
    }

    if (chunk.usage) {
      yield {
        type: 'usage',
        input: chunk.usage.prompt_tokens,
        output: chunk.usage.completion_tokens,
        cacheRead: cacheReadTokens(chunk.usage),
      };
    }
  }

  yield { type: 'done', finishReason };
}

export interface StreamChatParams {
  client: OpenAI;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  signal?: AbortSignal;
  /** Applies to opening the stream only; a stream that fails midway is not replayed here. */
  retry?: RetryOptions;
}

/** Streams one chat completion as typed events. Errors surface as ProviderError. */
export async function* streamChat(
  params: StreamChatParams,
): AsyncGenerator<StreamEvent> {
  const { client, model, messages, tools, signal } = params;
  const stream = await withRetry(
    () =>
      client.chat.completions.create(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools && tools.length > 0 && { tools }),
        },
        signal ? { signal } : {},
      ),
    { ...params.retry, signal },
  );
  try {
    yield* accumulateChunks(stream);
  } catch (thrown) {
    throw toProviderError(thrown);
  }
}
