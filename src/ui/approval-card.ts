import type { ApprovalRequest } from '../safety/approvals.ts';
import { type Line, type Seg, truncate, wrap } from './lines.ts';
import type { Token } from './theme.ts';
import { DIFF_ROWS, editDiff } from './tool-card.ts';

/** choose: waiting for y/a/n/e. reason: typing why not. edit: editing the command. */
export type CardPhase = 'choose' | 'reason' | 'edit';

const PREVIEW_ROWS = 10;
/** Command rows before the rest is summarised; `e` shows the whole command. */
const COMMAND_ROWS = 8;
const INDENT = '    ';

function str(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function title(request: ApprovalRequest): string {
  const path = str(request.args, 'file_path');
  if (request.kind === 'shell')
    return request.destructive
      ? 'Run this destructive command?'
      : 'Run this command?';
  if (request.tool === 'edit') return `Allow this edit to ${path ?? 'a file'}?`;
  return `Allow writing ${path ?? 'a file'}?`;
}

/** The change itself: the command, the edit's diff, or the start of a new file. */
function preview(
  request: ApprovalRequest,
  columns: number,
  budget: number,
): Line[] {
  const accent: Token = request.destructive ? 'jam' : 'dough';
  if (request.command !== null) {
    const rows = request.command.split('\n').flatMap((line, i) =>
      wrap(
        [
          {
            text: i === 0 ? `${INDENT}$ ` : `${INDENT}  `,
            fg: accent,
            bold: true,
          },
          { text: line, fg: accent, bold: true },
        ],
        columns,
        `${INDENT}  `,
      ),
    );
    return capped(rows, Math.min(COMMAND_ROWS, budget));
  }
  const diff = request.tool === 'edit' ? editDiff(request.args) : null;
  const rows: { sign: '+' | '-'; text: string }[] =
    diff?.rows ??
    (str(request.args, 'content') ?? '')
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)
      .map((text) => ({ sign: '+' as const, text }));
  // Up to DIFF_ROWS/PREVIEW_ROWS of content, and never more than the budget (the "more" row included).
  const most = diff ? DIFF_ROWS : PREVIEW_ROWS;
  const shown =
    rows.length <= Math.min(most, budget)
      ? rows.length
      : Math.max(1, Math.min(most, budget - 1));
  const lines: Line[] = rows.slice(0, shown).map((row) =>
    truncate(
      [
        { text: INDENT },
        {
          text: `${row.sign === '+' ? '+' : '−'} ${row.text.replaceAll('\t', '  ')}`,
          fg: row.sign === '+' ? 'matcha' : 'jam',
        },
      ],
      columns,
    ),
  );
  const hidden = rows.length - shown;
  if (hidden > 0)
    lines.push([
      {
        text: `${INDENT}… ${hidden} more line${hidden === 1 ? '' : 's'}`,
        fg: 'chip',
      },
    ]);
  return lines;
}

/** At most `max` rows, the last one saying how many more there are. */
function capped(rows: Line[], max: number): Line[] {
  if (rows.length <= max) return rows;
  const keep = Math.max(1, max - 1);
  const hidden = rows.length - keep;
  return [
    ...rows.slice(0, keep),
    [
      {
        text: `${INDENT}… ${hidden} more line${hidden === 1 ? '' : 's'}`,
        fg: 'chip',
      },
    ],
  ];
}

function keyHints(request: ApprovalRequest, phase: CardPhase): Seg[] {
  if (phase === 'reason')
    return [
      {
        text: '  Why not? Optional: type a reason · enter sends · esc back',
        fg: 'chip',
      },
    ];
  if (phase === 'edit')
    return [
      { text: '  Edit the command · enter runs it · esc back', fg: 'chip' },
    ];
  const key = (k: string): Seg => ({ text: k, fg: 'crust', bold: true });
  const label = (t: string): Seg => ({ text: t, fg: 'chip' });
  const always =
    request.kind === 'shell' ? ' always (this command)' : ' always (all edits)';
  const segs: Seg[] = [{ text: '  ' }, key('y'), label(' yes · ')];
  if (request.canAlways) segs.push(key('a'), label(`${always} · `));
  segs.push(key('n'), label(' no'));
  if (request.command !== null)
    segs.push(label(' · '), key('e'), label(' edit'));
  return segs;
}

/**
 * The approval card: a rule, the question, the preview, why it must be confirmed, and the
 * keys, in at most `maxRows` rows (the preview shrinks first). Destructive commands are drawn
 * in jam red throughout.
 */
export function approvalCard(
  request: ApprovalRequest,
  columns: number,
  phase: CardPhase,
  maxRows = Number.POSITIVE_INFINITY,
): Line[] {
  const tone: Token = request.destructive ? 'jam' : 'crust';
  const reasons = request.reasons.flatMap((reason) =>
    wrap(
      [
        { text: `${INDENT}! `, fg: 'jam' },
        { text: reason, fg: 'jam' },
      ],
      columns,
      `${INDENT}  `,
    ),
  );
  const budget = Math.max(1, maxRows - 3 - reasons.length);
  const rows: Line[] = [
    [{ text: '─'.repeat(columns), fg: request.destructive ? 'jam' : 'butter' }],
    truncate(
      [
        { text: request.destructive ? '  ⚠ ' : '  ? ', fg: tone, bold: true },
        { text: title(request), fg: tone, bold: true },
      ],
      columns,
    ),
    ...preview(request, columns, budget),
    ...reasons,
  ];
  rows.push(truncate(keyHints(request, phase), columns));
  return rows;
}
