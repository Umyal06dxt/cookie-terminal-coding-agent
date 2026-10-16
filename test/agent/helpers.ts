import { expect } from 'bun:test';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentEvent } from '../../src/agent/events.ts';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/agent/session.ts';
import type { AgentTool, ToolOutput } from '../../src/tools/types.ts';
import { fakeModel, type ScriptedTurn } from '../fake-model.ts';
/** A tool that records its calls and answers with `respond`. */
export function tool(
  name: string,
  respond: (
    args: unknown,
    signal: AbortSignal,
  ) => ToolOutput | Promise<ToolOutput> = () => ({
    ok: true,
    content: `${name} ok`,
  }),
) {
  const calls: unknown[] = [];
  const t: AgentTool = {
    name,
    description: `the ${name} tool`,
    parameters: { type: 'object', properties: {} },
    run: async (args, { signal }) => {
      calls.push(args);
      return respond(args, signal);
    },
  };
  return Object.assign(t, { calls });
}

/** Every assistant tool call is followed by its tool message before the next assistant/user turn. */
export function expectValidHistory(messages: ChatCompletionMessageParam[]) {
  for (const [i, m] of messages.entries()) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const ids = m.tool_calls.map((c) => c.id);
    const following = messages.slice(i + 1, i + 1 + ids.length);
    expect(
      following.map((f) =>
        f.role === 'tool' ? f.tool_call_id : `<${f.role}>`,
      ),
    ).toEqual(ids);
  }
}

export async function run(
  script: ScriptedTurn[],
  tools: AgentTool[] = [],
  extra: { maxTurns?: number; signal?: AbortSignal } = {},
) {
  const session = new Session([{ role: 'user', content: 'bake me a cookie' }]);
  const model = fakeModel(script);
  const events: AgentEvent[] = [];
  const reason = await runAgent({
    session,
    tools,
    model: 'fake-flash',
    stream: model,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  expectValidHistory(session.messages);
  expect(session.unansweredToolCalls()).toEqual([]);
  const end = events.at(-1);
  if (end?.type !== 'agent_end')
    throw new Error('the last event must be agent_end');
  return { reason, session, model, events, end };
}

export const of = <T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
