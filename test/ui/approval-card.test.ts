import { describe, expect, test } from 'bun:test';
import type { ApprovalRequest } from '../../src/safety/approvals.ts';
import { approvalCard } from '../../src/ui/approval-card.ts';
import { approvalIntent } from '../../src/ui/approval-keys.ts';
import { key } from '../../src/ui/keymap.ts';
import { texts, widest } from './helpers.ts';

const shell = (
  command: string,
  over: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  tool: 'bash',
  kind: 'shell',
  args: { command },
  command,
  destructive: false,
  reasons: [],
  canAlways: true,
  ...over,
});

const push = shell('git push origin main', {
  destructive: true,
  reasons: ['git push: changes a remote'],
  canAlways: false,
});

describe('approvalCard', () => {
  test('a command: question, preview, keys', () => {
    const rows = texts(approvalCard(shell('bun run build'), 60, 'choose'));
    expect(rows.slice(1)).toEqual([
      '  ? Run this command?',
      '    $ bun run build',
      '  y yes · a always (this command) · n no · e edit',
    ]);
  });

  test('destructive commands are drawn in jam, with the reason and no "always"', () => {
    const card = approvalCard(push, 60, 'choose');
    expect(texts(card).slice(1)).toEqual([
      '  ⚠ Run this destructive command?',
      '    $ git push origin main',
      '    ! git push: changes a remote',
      '  y yes · n no · e edit',
    ]);
    expect(card[0]?.[0]?.fg).toBe('jam');
    expect(card[1]?.every((s) => s.fg === 'jam')).toBe(true);
    expect(card[2]?.every((s) => s.fg === 'jam')).toBe(true);
    const safe = approvalCard(shell('ls'), 60, 'choose');
    expect(safe.flat().some((s) => s.fg === 'jam')).toBe(false);
  });

  test('an edit shows its diff; a new file shows its first lines', () => {
    const edit = approvalCard(
      {
        tool: 'edit',
        kind: 'write',
        args: { file_path: 'src/a.ts', old_string: 'one', new_string: 'two' },
        command: null,
        destructive: false,
        reasons: [],
        canAlways: true,
      },
      60,
      'choose',
    );
    expect(texts(edit).slice(1)).toEqual([
      '  ? Allow this edit to src/a.ts?',
      '    − one',
      '    + two',
      '  y yes · a always (all edits) · n no',
    ]);
    const content = Array.from({ length: 14 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const write = texts(
      approvalCard(
        {
          tool: 'write',
          kind: 'write',
          args: { file_path: 'b.ts', content },
          command: null,
          destructive: false,
          reasons: [],
          canAlways: true,
        },
        60,
        'choose',
      ),
    );
    expect(write[1]).toBe('  ? Allow writing b.ts?');
    expect(write[2]).toBe('    + line 0');
    expect(write.at(-2)).toBe('    … 4 more lines');
  });

  test('the reason and edit phases say what enter does', () => {
    expect(texts(approvalCard(push, 80, 'reason')).at(-1)).toContain(
      'enter sends',
    );
    expect(texts(approvalCard(push, 80, 'edit')).at(-1)).toContain(
      'enter runs it',
    );
  });

  test('maxRows shrinks the preview first and keeps the reasons and keys', () => {
    const script = Array.from(
      { length: 30 },
      (_, i) => `rm -rf /tmp/x${i}`,
    ).join('\n');
    const card = texts(
      approvalCard({ ...push, command: script }, 80, 'choose', 9),
    );
    expect(card).toHaveLength(9);
    expect(card.at(-3)).toBe('    … 26 more lines');
    expect(card.at(-2)).toBe('    ! git push: changes a remote');
    expect(card.at(-1)).toBe('  y yes · n no · e edit');
    // Without a limit a command still stops at 8 rows.
    expect(
      texts(approvalCard({ ...push, command: script }, 80, 'choose')),
    ).toHaveLength(12);
  });

  test('long commands wrap and nothing is wider than the screen', () => {
    const card = approvalCard(
      shell(`echo ${'word '.repeat(40)}`),
      40,
      'choose',
    );
    expect(widest(card)).toBeLessThanOrEqual(40);
    expect(card.length).toBeGreaterThan(5);
  });
});

describe('approvalIntent', () => {
  test('y, a, n, e on the card', () => {
    const r = shell('bun run build');
    expect(approvalIntent('y', key(), 'choose', r)).toEqual({ type: 'yes' });
    expect(approvalIntent('a', key(), 'choose', r)).toEqual({ type: 'always' });
    expect(approvalIntent('n', key(), 'choose', r)).toEqual({
      type: 'ask-reason',
    });
    expect(approvalIntent('e', key(), 'choose', r)).toEqual({
      type: 'start-edit',
    });
    expect(approvalIntent('x', key(), 'choose', r)).toEqual({ type: 'none' });
    expect(approvalIntent('', key({ escape: true }), 'choose', r)).toEqual({
      type: 'interrupt',
    });
  });

  test('a does nothing on destructive cards; e does nothing for file edits', () => {
    expect(approvalIntent('a', key(), 'choose', push)).toEqual({
      type: 'none',
    });
    expect(
      approvalIntent('e', key(), 'choose', { ...shell('x'), command: null }),
    ).toEqual({ type: 'none' });
  });

  test('in the reason or edit box, keys type, enter sends, esc goes back', () => {
    const r = shell('ls');
    expect(approvalIntent('y', key(), 'reason', r)).toEqual({
      type: 'edit',
      action: { type: 'insert', text: 'y' },
    });
    expect(approvalIntent('', key({ return: true }), 'edit', r)).toEqual({
      type: 'send',
    });
    expect(approvalIntent('', key({ escape: true }), 'edit', r)).toEqual({
      type: 'back',
    });
    expect(approvalIntent('c', key({ ctrl: true }), 'edit', r)).toEqual({
      type: 'ctrl-c',
    });
  });
});
