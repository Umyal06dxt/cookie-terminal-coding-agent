import type { AgentEvent } from '../../src/agent/events.ts';
import { type Line, lineText, lineWidth } from '../../src/ui/lines.ts';
import {
  initialState,
  reduce,
  type StatusInfo,
  type UiState,
} from '../../src/ui/state.ts';

export const STATUS: StatusInfo = {
  model: 'deepseek-v4.1-flash',
  folder: '~/acme-monorepo',
  branch: 'feat/upload-quota',
  contextWindow: 128_000,
  price: { input: 0.15, output: 0.6, cache_read: 0.03 },
};

export function stateAfter(
  events: AgentEvent[],
  status: StatusInfo = STATUS,
): UiState {
  return events.reduce(
    (state, event) => reduce(state, { type: 'agent', event }),
    reduce(initialState(status), { type: 'submit', text: 'hi' }),
  );
}

export const texts = (lines: readonly Line[]) => lines.map(lineText);

export function widest(lines: readonly Line[]): number {
  return Math.max(0, ...lines.map(lineWidth));
}

/** A frame's rows without colour codes. */
export function frameRows(frame: string | undefined): string[] {
  return (frame ?? '').split('\n').map((row) => Bun.stripANSI(row));
}
