import type { AgentEndReason, AgentEvent } from '../agent/events.ts';
import type { ModelPrice } from '../config/schema.ts';

/** One block in the transcript. */
export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      key: string;
      /** The tool call id. */
      id: string;
      name: string;
      args: unknown;
      status: 'running' | 'ok' | 'failed';
      summary: string;
      durationMs: number | null;
    }
  | { kind: 'notice'; key: string; tone: 'error' | 'info'; text: string };

export interface StatusInfo {
  model: string;
  /** The project folder, as shown (e.g. "~/acme"). */
  folder: string;
  branch: string;
  /** Tokens; null when the catalog doesn't say. */
  contextWindow: number | null;
  /** Null when cookie.toml has no [pricing] entry for the model, so no cost is shown. */
  price: ModelPrice | null;
}

export interface Usage {
  /** The latest request's prompt size: what fills the context window. */
  lastPrompt: number;
  input: number;
  output: number;
  cacheRead: number;
  /** USD; null when the model has no price. */
  cost: number | null;
}

export interface UiState {
  items: Item[];
  status: StatusInfo;
  usage: Usage;
  /** A turn is running. */
  busy: boolean;
  /** Something went wrong in this run; the spinner stays hidden. */
  failed: boolean;
  lastEnd: AgentEndReason | null;
  nextKey: number;
}

export type UiAction =
  | { type: 'agent'; event: AgentEvent }
  /** The user sent a message; a run starts. */
  | { type: 'submit'; text: string }
  | { type: 'notice'; tone: 'error' | 'info'; text: string };

export function initialState(status: StatusInfo): UiState {
  return {
    items: [],
    status,
    usage: {
      lastPrompt: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cost: status.price ? 0 : null,
    },
    busy: false,
    failed: false,
    lastEnd: null,
    nextKey: 0,
  };
}

/** USD for one request. Cached prompt tokens bill at cache_read (or the input price). */
export function requestCost(
  price: ModelPrice,
  usage: { input: number; output: number; cacheRead: number },
): number {
  const cached = Math.min(usage.cacheRead, usage.input);
  const fresh = usage.input - cached;
  const perToken = 1 / 1_000_000;
  return (
    (fresh * price.input +
      cached * (price.cache_read ?? price.input) +
      usage.output * price.output) *
    perToken
  );
}

/** 0–1, or null when the window size is unknown. */
export function contextFraction(state: UiState): number | null {
  const window = state.status.contextWindow;
  if (window === null || window <= 0) return null;
  return Math.min(1, state.usage.lastPrompt / window);
}

/** The spinner shows while a turn runs, and never once something has failed. */
export function spinnerVisible(state: UiState): boolean {
  return state.busy && !state.failed;
}

function add(state: UiState, item: DistributiveOmit<Item, 'key'>): UiState {
  const key = `i${state.nextKey}`;
  return {
    ...state,
    items: [...state.items, { ...item, key } as Item],
    nextKey: state.nextKey + 1,
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Replaces the last item when `match` accepts it; otherwise returns null. */
function updateLast(
  state: UiState,
  update: (item: Item) => Item | null,
): UiState | null {
  const last = state.items.at(-1);
  if (!last) return null;
  const next = update(last);
  if (next === null) return null;
  return { ...state, items: [...state.items.slice(0, -1), next] };
}

/** Ends any assistant text still streaming. */
function settle(state: UiState): UiState {
  return (
    updateLast(state, (item) =>
      item.kind === 'assistant' && item.streaming
        ? { ...item, streaming: false }
        : null,
    ) ?? state
  );
}

const END_NOTICES: Partial<Record<AgentEndReason, 'error' | 'info'>> = {
  interrupted: 'info',
  max_turns: 'error',
  budget: 'error',
  error: 'error',
};

function onEvent(state: UiState, event: AgentEvent): UiState {
  switch (event.type) {
    case 'turn_start':
      return { ...state, busy: true };
    case 'text_delta': {
      if (event.text === '') return state;
      const appended = updateLast(state, (item) =>
        item.kind === 'assistant' && item.streaming
          ? { ...item, text: item.text + event.text }
          : null,
      );
      return (
        appended ??
        add(state, { kind: 'assistant', text: event.text, streaming: true })
      );
    }
    case 'tool_call':
      return add(settle(state), {
        kind: 'tool',
        id: event.id,
        name: event.name,
        args: event.args,
        status: 'running',
        summary: '',
        durationMs: null,
      });
    case 'tool_result': {
      // Search from the end: ids are unique per run, but not across runs.
      const index = state.items.findLastIndex(
        (item) => item.kind === 'tool' && item.id === event.id,
      );
      const found = state.items[index];
      if (found?.kind !== 'tool') return state;
      const items = [...state.items];
      items[index] = {
        ...found,
        status: event.ok ? 'ok' : 'failed',
        summary: event.summary,
        durationMs: event.durationMs,
      };
      return { ...state, items };
    }
    case 'usage': {
      const { price } = state.status;
      const usage = state.usage;
      return {
        ...state,
        usage: {
          lastPrompt: event.input,
          input: usage.input + event.input,
          output: usage.output + event.output,
          cacheRead: usage.cacheRead + event.cacheRead,
          cost:
            price === null || usage.cost === null
              ? null
              : usage.cost + requestCost(price, event),
        },
      };
    }
    case 'turn_end':
      return settle(state);
    case 'error':
      return {
        ...add(settle(state), {
          kind: 'notice',
          tone: 'error',
          text: event.message,
        }),
        failed: true,
      };
    case 'agent_end': {
      const ended: UiState = {
        ...settle(state),
        busy: false,
        lastEnd: event.reason,
        failed: state.failed || END_NOTICES[event.reason] === 'error',
      };
      const tone = END_NOTICES[event.reason];
      return tone
        ? add(ended, { kind: 'notice', tone, text: event.summary })
        : ended;
    }
  }
}

export function reduce(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'agent':
      return onEvent(state, action.event);
    case 'submit':
      return {
        ...add(settle(state), { kind: 'user', text: action.text }),
        busy: true,
        failed: false,
        lastEnd: null,
      };
    case 'notice':
      return add(state, {
        kind: 'notice',
        tone: action.tone,
        text: action.text,
      });
  }
}
