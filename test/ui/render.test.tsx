import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { StatusBar } from '../../src/ui/components/status-bar.tsx';
import { ToolCard } from '../../src/ui/components/tool-card.tsx';
import { Transcript } from '../../src/ui/components/transcript.tsx';
import { frameRows, stateAfter } from './helpers.ts';

afterEach(cleanup);

const COLUMNS = 80;

function expectFits(rows: string[]) {
  for (const row of rows)
    expect(Bun.stringWidth(row)).toBeLessThanOrEqual(COLUMNS);
}

describe('render at 80 columns', () => {
  test('status bar: one row of facts and a rule', () => {
    const state = stateAfter([
      { type: 'usage', input: 52_480, output: 2_000, cacheRead: 0 },
    ]);
    const { lastFrame } = render(<StatusBar state={state} width={COLUMNS} />);
    const rows = frameRows(lastFrame());
    expect(rows).toEqual([
      ' (•) deepseek-v4.1-flash · acme-monorepo · feat/upload-quota  crumbs 41%  $0.01',
      '─'.repeat(COLUMNS),
    ]);
    expectFits(rows);
  });

  test('a tool card with its diff', () => {
    const { lastFrame } = render(
      <ToolCard
        width={COLUMNS}
        item={{
          kind: 'tool',
          key: 'k',
          id: 'c',
          name: 'edit',
          args: {
            file_path: 'apps/api/routes/upload.ts',
            old_string: 'return ok()',
            new_string:
              'if (used + size > user.quotaBytes) {\n  return json({ error: "QUOTA_EXCEEDED" }, 413)\n}\nreturn ok()',
          },
          status: 'ok',
          summary: 'replaced 1 occurrence',
          durationMs: 120,
        }}
      />,
    );
    const rows = frameRows(lastFrame());
    expect(rows[0]).toMatch(
      /^ {2}▾ Edit {2}apps\/api\/routes\/upload\.ts +\+3 −0 {2}0\.12s$/,
    );
    expect(rows[0]).toHaveLength(COLUMNS);
    expect(rows.slice(1)).toEqual([
      '     + if (used + size > user.quotaBytes) {',
      '     +   return json({ error: "QUOTA_EXCEEDED" }, 413)',
      '     + }',
    ]);
    expectFits(rows);
  });

  test('the transcript keeps the newest rows that fit its height', () => {
    const state = stateAfter([
      {
        type: 'text_delta',
        text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
      },
    ]);
    const { lastFrame } = render(
      <Transcript items={state.items} width={COLUMNS} height={5} />,
    );
    const rows = frameRows(lastFrame());
    expect(rows.map((r) => r.trim())).toEqual([
      'line 25',
      'line 26',
      'line 27',
      'line 28',
      'line 29',
    ]);
  });
});
