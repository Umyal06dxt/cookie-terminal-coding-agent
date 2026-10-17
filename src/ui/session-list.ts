import { localTime, type SessionSummary } from '../storage/sessions.ts';
import { type Line, truncate } from './lines.ts';
import { formatCost } from './status.ts';

/** The --resume list: when, what it cost, and the first message, one row each. */
export function sessionRows(
  sessions: readonly SessionSummary[],
  selected: number,
  columns: number,
): Line[] {
  const header: Line[] = [
    [{ text: '  Resume a session', fg: 'crust', bold: true }],
    [{ text: '  ↑/↓ choose · enter opens · esc quits', fg: 'chip' }],
    [],
  ];
  return [
    ...header,
    ...sessions.map((s, i) => {
      const active = i === selected;
      const cost = s.cost === null ? '' : formatCost(s.cost);
      return truncate(
        [
          { text: active ? ' › ' : '   ', fg: 'crust', bold: true },
          { text: localTime(s.created), fg: 'chip' },
          { text: `  ${cost.padStart(6)}  `, fg: 'chip' },
          {
            text: s.firstMessage,
            fg: active ? 'crust' : 'dough',
            bold: active,
          },
        ],
        columns,
      );
    }),
  ];
}
