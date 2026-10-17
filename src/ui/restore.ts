import type { LogRecord } from '../storage/sessionLog.ts';
import { localTime } from '../storage/sessions.ts';
import {
  initialState,
  reduce,
  type StatusInfo,
  type UiState,
} from './state.ts';

/**
 * The transcript of a logged session, rebuilt by replaying what the user typed and what the
 * agent did through the same reducer the live UI uses. A run cut off by a crash is closed off,
 * so the restored screen is idle and says what happened.
 */
export function replayState(
  records: readonly LogRecord[],
  status: StatusInfo,
): UiState {
  let state = initialState(status);
  for (const r of records) {
    if (r.t === 'submit')
      state = reduce(state, { type: 'submit', text: r.text });
    else if (r.t === 'event')
      state = reduce(state, { type: 'agent', event: r.event });
  }
  if (state.busy) {
    state = reduce(state, {
      type: 'agent',
      event: {
        type: 'agent_end',
        reason: 'interrupted',
        turns: 0,
        summary: 'This session ended mid-run (the last step may be missing).',
      },
    });
  }
  // Running tool cards from a crash would spin forever; they never finished.
  state = {
    ...state,
    items: state.items.map((item) =>
      item.kind === 'tool' && item.status === 'running'
        ? { ...item, status: 'failed', summary: 'never finished' }
        : item,
    ),
  };
  const created = records.find((r) => r.t === 'meta');
  const when =
    created?.t === 'meta'
      ? ` from ${localTime(new Date(created.created))}`
      : '';
  return reduce(state, {
    type: 'notice',
    tone: 'info',
    text: `Resumed the session${when}.`,
  });
}
