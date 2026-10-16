import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { type ProviderError, toProviderError } from '../provider/errors.ts';
import type { ChatStream } from '../provider/stream.ts';
import type { AgentTool } from '../tools/types.ts';
import type { AgentEndReason, EventSink } from './events.ts';
import {
  answerUnrun,
  INTERRUPTED_BEFORE,
  LOOP_LIMIT,
  LoopDetector,
  runToolCalls,
} from './run-tools.ts';
import type { Session, ToolCallRecord } from './session.ts';

export const DEFAULT_MAX_TURNS = 40;

export const CONTINUE_PROMPT =
  'Your last reply was cut off by the output limit. Continue exactly where you stopped, without repeating anything.';
const CUT_OFF_CALLS =
  ' The tool call you were writing was cut off too; send it again in full.';
const NOT_RUN_STREAM_FAILED = 'Not run: the reply failed before it finished.';

export interface RunAgentOptions {
  session: Session;
  tools: readonly AgentTool[];
  model: string;
  /** `bindStream(client)` in production, `fakeModel(...)` in tests. */
  stream: ChatStream;
  signal?: AbortSignal;
  onEvent?: EventSink;
  maxTurns?: number;
}

interface TurnResult {
  text: string;
  calls: ToolCallRecord[];
  finishReason: string | null;
  error: ProviderError | undefined;
}

function toolSchemas(tools: readonly AgentTool[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Streams one reply, emitting events live. Never throws: a failure comes back in `error`. */
async function streamTurn(
  options: RunAgentOptions,
  signal: AbortSignal,
  emit: EventSink,
) {
  const result: TurnResult = {
    text: '',
    calls: [],
    finishReason: null,
    error: undefined,
  };
  try {
    const events = options.stream({
      model: options.model,
      messages: [...options.session.messages],
      tools: toolSchemas(options.tools),
      signal,
    });
    for await (const event of events) {
      if (event.type === 'text_delta') {
        result.text += event.text;
        emit({ type: 'text_delta', text: event.text });
      } else if (event.type === 'tool_call_end') {
        result.calls.push({
          id: event.id,
          name: event.name,
          argsJson: event.argsJson,
        });
      } else if (event.type === 'usage') {
        const usage = {
          input: event.input,
          output: event.output,
          cacheRead: event.cacheRead,
        };
        options.session.addUsage(usage);
        emit({ type: 'usage', ...usage });
      } else if (event.type === 'done') {
        result.finishReason = event.finishReason;
      }
    }
  } catch (thrown) {
    result.error = toProviderError(thrown);
  }
  return result;
}

function describeEnd(
  reason: AgentEndReason,
  turns: number,
  toolCounts: Map<string, number>,
  lastText: string,
): string {
  const head: Record<AgentEndReason, string> = {
    done: `Finished in ${turns} turn${turns === 1 ? '' : 's'}.`,
    max_turns: `Stopped after ${turns} turns, the max_turns limit, before the model said it was done.`,
    interrupted: `Interrupted by user after ${turns} turn${turns === 1 ? '' : 's'}.`,
    budget: `Stopped after ${turns} turns: the budget ran out.`,
    error: `Stopped after ${turns} turn${turns === 1 ? '' : 's'} because of an error.`,
  };
  const parts = [head[reason]];
  if (toolCounts.size > 0) {
    const counts = [...toolCounts]
      .map(([name, n]) => `${name} ×${n}`)
      .join(', ');
    parts.push(`Tool calls: ${counts}.`);
  }
  const said = lastText.trim();
  if (reason !== 'done' && said !== '') {
    parts.push(
      `Last thing the model said: "${said.length > 200 ? `${said.slice(0, 199)}…` : said}"`,
    );
  }
  return parts.join(' ');
}

/**
 * The agent loop: ask the model, run the tools it calls, repeat until it answers without
 * tools. Every tool call in the history gets a tool message, whichever way the run ends.
 */
export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentEndReason> {
  const { session } = options;
  const signal = options.signal ?? new AbortController().signal;
  const emit: EventSink = options.onEvent ?? (() => {});
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const loops = new LoopDetector(LOOP_LIMIT);
  const toolCounts = new Map<string, number>();
  let turn = 0;
  let lastText = '';

  const end = (reason: AgentEndReason): AgentEndReason => {
    emit({
      type: 'agent_end',
      reason,
      turns: turn,
      summary: describeEnd(reason, turn, toolCounts, lastText),
    });
    return reason;
  };

  while (true) {
    if (signal.aborted) return end('interrupted');
    if (turn >= maxTurns) return end('max_turns');
    turn++;
    emit({ type: 'turn_start', turn });

    const result = await streamTurn(options, signal, emit);
    if (result.text.trim() !== '') lastText = result.text;
    emit({ type: 'turn_end', turn, finishReason: result.finishReason });

    // The SDK may end a stream quietly on abort, so the signal decides, not just the error.
    const interrupted = signal.aborted || result.error?.kind === 'aborted';
    if (interrupted || result.error) {
      // Keep what arrived; answer any finished calls so the history stays valid.
      if (result.text !== '' || result.calls.length > 0) {
        session.addAssistant(result.text, result.calls);
      }
      answerUnrun(
        result.calls,
        interrupted ? INTERRUPTED_BEFORE : NOT_RUN_STREAM_FAILED,
        session,
        emit,
      );
      if (interrupted) return end('interrupted');
      if (result.error) {
        const detail = result.error.detail ? ` (${result.error.detail})` : '';
        emit({
          type: 'error',
          message: `${result.error.explanation}${detail}`,
        });
      }
      return end('error');
    }

    if (result.finishReason === 'length') {
      // Half-written tool calls can't be run; drop them and ask for the rest.
      if (result.text !== '') session.addAssistant(result.text);
      session.addUser(
        CONTINUE_PROMPT + (result.calls.length > 0 ? CUT_OFF_CALLS : ''),
      );
      continue;
    }

    if (result.calls.length === 0) {
      if (result.text !== '') session.addAssistant(result.text);
      return end('done');
    }

    session.addAssistant(result.text, result.calls);
    for (const call of result.calls)
      toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
    const outcome = await runToolCalls(result.calls, {
      tools: options.tools,
      session,
      signal,
      emit,
      loops,
    });
    if (outcome === 'interrupted') return end('interrupted');
    if (outcome === 'loop') {
      emit({
        type: 'error',
        message: `Stopped: the model made the same tool call ${LOOP_LIMIT} times in a row with identical arguments.`,
      });
      return end('error');
    }
  }
}
