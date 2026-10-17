import { describe, expect, test } from 'bun:test';
import { type Backend, ChatController } from '../../src/ui/controller.ts';
import type { UiAction } from '../../src/ui/state.ts';
import { fakeModel, type ScriptedTurn } from '../fake-model.ts';

function setup(turns: ScriptedTurn[]) {
  const model = fakeModel(turns);
  const backend: Backend = {
    model: 'fake',
    stream: model,
    tools: [],
    systemPrompt: 'You are Cookie.',
    maxTurns: 5,
    contextWindow: 1000,
  };
  const actions: UiAction[] = [];
  const controller = new ChatController(
    Promise.resolve({ ok: true, backend }),
    (a) => actions.push(a),
  );
  const events = () =>
    actions.flatMap((a) => (a.type === 'agent' ? [a.event.type] : []));
  return { model, controller, actions, events };
}

describe('ChatController', () => {
  test('a message runs the agent and streams events to the UI', async () => {
    const { controller, actions, events } = setup([{ text: 'Hello!' }]);
    await controller.submit('hi');
    expect(actions[0]).toEqual({ type: 'submit', text: 'hi' });
    expect(events()).toContain('text_delta');
    expect(events().at(-1)).toBe('agent_end');
    expect(controller.busy).toBe(false);
  });

  test('one session across messages, with the system prompt first', async () => {
    const { controller, model } = setup([{ text: 'one' }, { text: 'two' }]);
    await controller.submit('first');
    await controller.submit('second');
    const messages = model.requests[1]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are Cookie.' });
  });

  test('a message sent mid-run is ignored, not queued into the same session', async () => {
    const { controller, model } = setup([{ text: 'slow' }, { text: 'never' }]);
    const first = controller.submit('a');
    await controller.submit('b');
    await first;
    expect(model.requests).toHaveLength(1);
  });

  test('interrupt aborts the running turn (esc / first ctrl+c)', async () => {
    let controller: ChatController | null = null;
    const ctx = setup([
      {
        steps: [
          { type: 'text_delta', text: 'Thinking' },
          () => controller?.interrupt(),
          { type: 'text_delta', text: ' more' },
        ],
      },
    ]);
    controller = ctx.controller;
    await ctx.controller.submit('go');
    const end = ctx.actions.flatMap((a) =>
      a.type === 'agent' && a.event.type === 'agent_end' ? [a.event] : [],
    );
    expect(end[0]?.reason).toBe('interrupted');
    expect(ctx.controller.interrupt()).toBe(false);
  });

  test('clear forgets the conversation', async () => {
    const { controller, model, actions } = setup([
      { text: 'one' },
      { text: 'two' },
    ]);
    await controller.submit('first');
    controller.clear();
    expect(actions.at(-1)).toEqual({ type: 'clear' });
    await controller.submit('again');
    expect(model.requests[1]?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
    ]);
  });

  test('a provider that failed to start answers with its message', async () => {
    const actions: UiAction[] = [];
    const controller = new ChatController(
      Promise.resolve({
        ok: false,
        message: 'COMMANDCODE_API_KEY is not set.',
      }),
      (a) => actions.push(a),
    );
    await controller.submit('hi');
    expect(actions[1]).toEqual({
      type: 'agent',
      event: { type: 'error', message: 'COMMANDCODE_API_KEY is not set.' },
    });
    expect(actions.at(-1)).toMatchObject({
      type: 'agent',
      event: { type: 'agent_end', reason: 'error' },
    });
    expect(controller.busy).toBe(false);
  });
});
