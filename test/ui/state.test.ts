import { describe, expect, test } from 'bun:test';
import type { AgentEvent } from '../../src/agent/events.ts';
import {
  contextFraction,
  initialState,
  reduce,
  requestCost,
  spinnerVisible,
  type UiState,
} from '../../src/ui/state.ts';
import { STATUS, stateAfter } from './helpers.ts';

/**
 * One case per AgentEvent type. `satisfies Record<…>` makes a new event type a typecheck error
 * until it gets a test here.
 */
const cases = {
  turn_start: () => {
    const state = stateAfter([{ type: 'turn_start', turn: 1 }]);
    expect(state.busy).toBe(true);
    expect(spinnerVisible(state)).toBe(true);
  },
  text_delta: () => {
    const state = stateAfter([
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: '' },
      { type: 'text_delta', text: ', world' },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      kind: 'assistant',
      text: 'Hello, world',
      streaming: true,
    });
    expect(state.items).toHaveLength(2);
  },
  tool_call: () => {
    const state = stateAfter([
      { type: 'text_delta', text: 'Reading.' },
      {
        type: 'tool_call',
        id: 'c1',
        name: 'read',
        args: { file_path: 'a.ts' },
      },
    ]);
    expect(state.items[1]).toMatchObject({
      kind: 'assistant',
      streaming: false,
    });
    expect(state.items[2]).toMatchObject({
      kind: 'tool',
      id: 'c1',
      name: 'read',
      status: 'running',
      durationMs: null,
    });
  },
  tool_result: () => {
    const state = stateAfter([
      { type: 'tool_call', id: 'c1', name: 'read', args: {} },
      { type: 'tool_call', id: 'c2', name: 'bash', args: {} },
      {
        type: 'tool_result',
        id: 'c2',
        name: 'bash',
        ok: false,
        summary: 'exit 1',
        durationMs: 40,
      },
      {
        type: 'tool_result',
        id: 'c1',
        name: 'read',
        ok: true,
        summary: '3 lines',
        durationMs: 20,
      },
    ]);
    expect(state.items[1]).toMatchObject({
      status: 'ok',
      summary: '3 lines',
      durationMs: 20,
    });
    expect(state.items[2]).toMatchObject({
      status: 'failed',
      summary: 'exit 1',
    });
  },
  usage: () => {
    const state = stateAfter([
      { type: 'usage', input: 1_000_000, output: 100_000, cacheRead: 500_000 },
      { type: 'usage', input: 64_000, output: 0, cacheRead: 0 },
    ]);
    expect(state.usage).toMatchObject({
      lastPrompt: 64_000,
      input: 1_064_000,
      output: 100_000,
      cacheRead: 500_000,
    });
    // 0.5M fresh × 0.15 + 0.5M cached × 0.03 + 0.1M out × 0.6, then 64k × 0.15.
    expect(state.usage.cost).toBeCloseTo(0.075 + 0.015 + 0.06 + 0.0096, 10);
    expect(contextFraction(state)).toBe(0.5);
  },
  turn_end: () => {
    const state = stateAfter([
      { type: 'text_delta', text: 'done' },
      { type: 'turn_end', turn: 1, finishReason: 'stop' },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      kind: 'assistant',
      streaming: false,
    });
    expect(state.busy).toBe(true);
  },
  error: () => {
    const state = stateAfter([
      { type: 'turn_start', turn: 1 },
      { type: 'error', message: 'The provider is down.' },
    ]);
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      tone: 'error',
      text: 'The provider is down.',
    });
    expect(spinnerVisible(state)).toBe(false);
  },
  agent_end: () => {
    const done = stateAfter([
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', text: 'All set.' },
      {
        type: 'agent_end',
        reason: 'done',
        turns: 1,
        summary: 'Finished in 1 turn.',
      },
    ]);
    expect(done.busy).toBe(false);
    expect(done.lastEnd).toBe('done');
    // A clean finish adds no notice; the answer speaks for itself.
    expect(done.items.at(-1)).toMatchObject({
      kind: 'assistant',
      streaming: false,
    });
  },
} satisfies Record<AgentEvent['type'], () => void>;

describe('reduce: every agent event', () => {
  for (const [type, run] of Object.entries(cases)) test(type, run);
});

describe('reduce', () => {
  test('submit adds the user message and starts a run', () => {
    const state = reduce(initialState(STATUS), {
      type: 'submit',
      text: 'add quotas',
    });
    expect(state.items).toEqual([
      { kind: 'user', key: 'i0', text: 'add quotas' },
    ]);
    expect(state.busy).toBe(true);
  });

  test('keys are unique and stable', () => {
    const state = stateAfter([
      { type: 'text_delta', text: 'a' },
      { type: 'tool_call', id: 'x', name: 'read', args: {} },
      { type: 'text_delta', text: 'b' },
    ]);
    expect(state.items.map((i) => i.key)).toEqual(['i0', 'i1', 'i2', 'i3']);
  });

  test('text after a tool call starts a new assistant block', () => {
    const state = stateAfter([
      { type: 'text_delta', text: 'first' },
      { type: 'tool_call', id: 'x', name: 'read', args: {} },
      { type: 'text_delta', text: 'second' },
    ]);
    expect(state.items.filter((i) => i.kind === 'assistant')).toHaveLength(2);
  });

  test('a tool result for an unknown id changes nothing', () => {
    const before = stateAfter([]);
    const after = reduce(before, {
      type: 'agent',
      event: {
        type: 'tool_result',
        id: 'ghost',
        name: 'read',
        ok: true,
        summary: '',
        durationMs: 1,
      },
    });
    expect(after).toBe(before);
  });

  test('the same call id in a later run updates the later card', () => {
    let state = stateAfter([
      { type: 'tool_call', id: 'call_0', name: 'read', args: {} },
      {
        type: 'tool_result',
        id: 'call_0',
        name: 'read',
        ok: true,
        summary: 'old',
        durationMs: 1,
      },
    ]);
    state = reduce(state, { type: 'submit', text: 'again' });
    state = reduce(state, {
      type: 'agent',
      event: { type: 'tool_call', id: 'call_0', name: 'read', args: {} },
    });
    state = reduce(state, {
      type: 'agent',
      event: {
        type: 'tool_result',
        id: 'call_0',
        name: 'read',
        ok: true,
        summary: 'new',
        durationMs: 1,
      },
    });
    const cards = state.items.filter((i) => i.kind === 'tool');
    expect(cards.map((c) => c.summary)).toEqual(['old', 'new']);
  });

  test.each([
    ['interrupted', 'info'],
    ['max_turns', 'error'],
    ['budget', 'error'],
    ['error', 'error'],
  ] as const)(
    'agent_end %s adds a %s notice with the summary',
    (reason, tone) => {
      const state = stateAfter([
        { type: 'turn_start', turn: 1 },
        { type: 'agent_end', reason, turns: 1, summary: `Stopped: ${reason}` },
      ]);
      expect(state.items.at(-1)).toMatchObject({
        kind: 'notice',
        tone,
        text: `Stopped: ${reason}`,
      });
      expect(state.busy).toBe(false);
    },
  );

  test('the spinner never shows after an error, even if a turn is still marked busy', () => {
    const state: UiState = stateAfter([
      { type: 'turn_start', turn: 1 },
      { type: 'error', message: 'boom' },
      { type: 'turn_start', turn: 2 },
    ]);
    expect(state.busy).toBe(true);
    expect(spinnerVisible(state)).toBe(false);
  });

  test('a new message clears the failure', () => {
    const failed = stateAfter([{ type: 'error', message: 'boom' }]);
    const next = reduce(failed, { type: 'submit', text: 'try again' });
    expect(spinnerVisible(next)).toBe(true);
  });

  test('no price means no cost, not $0.00', () => {
    const state = stateAfter(
      [{ type: 'usage', input: 1000, output: 10, cacheRead: 0 }],
      { ...STATUS, price: null, contextWindow: null },
    );
    expect(state.usage.cost).toBeNull();
    expect(contextFraction(state)).toBeNull();
  });

  test('notice actions append', () => {
    const state = reduce(initialState(STATUS), {
      type: 'notice',
      tone: 'info',
      text: 'hello',
    });
    expect(state.items).toEqual([
      { kind: 'notice', key: 'i0', tone: 'info', text: 'hello' },
    ]);
  });
});

describe('requestCost', () => {
  test('cache_read defaults to the input price', () => {
    expect(
      requestCost(
        { input: 1, output: 2 },
        { input: 1_000_000, output: 1_000_000, cacheRead: 400_000 },
      ),
    ).toBe(3);
  });

  test('cached tokens never exceed the prompt', () => {
    expect(
      requestCost(
        { input: 1, output: 0, cache_read: 0 },
        { input: 10, output: 0, cacheRead: 99 },
      ),
    ).toBe(0);
  });
});
