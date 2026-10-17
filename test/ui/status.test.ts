import { describe, expect, test } from 'bun:test';
import { lineText, lineWidth } from '../../src/ui/lines.ts';
import { initialState } from '../../src/ui/state.ts';
import {
  displayFolder,
  formatCost,
  meter,
  statusLine,
} from '../../src/ui/status.ts';
import { STATUS, stateAfter } from './helpers.ts';

const used = stateAfter([
  { type: 'usage', input: 52_480, output: 2_000, cacheRead: 0 },
]);

describe('statusLine', () => {
  test('glyph, model, folder, branch, crumbs and cost at 100 columns', () => {
    const line = statusLine(used, 100, '(•)');
    const text = lineText(line);
    expect(text).toStartWith(
      ' (•) cookie · deepseek-v4.1-flash · ~/acme-monorepo · feat/upload-quota',
    );
    expect(text).toEndWith('crumbs ▰▰□□□ 41%  $0.01 '.replaceAll('□', '▱'));
    expect(lineWidth(line)).toBe(100);
  });

  test('at 80 columns it drops "cookie", the folder parents and the bar, in that order', () => {
    const roomy = { ...used, status: { ...STATUS, model: 'ds-flash' } };
    expect(lineText(statusLine(roomy, 80, '(•)'))).toStartWith(
      ' (•) ds-flash · ~/acme-monorepo · feat/upload-quota',
    );
    const line = statusLine(used, 80, '(•)');
    expect(lineText(line)).toBe(
      ' (•) deepseek-v4.1-flash · acme-monorepo · feat/upload-quota  crumbs 41%  $0.01 ',
    );
    expect(lineWidth(line)).toBe(80);
  });

  test('when even that is too wide, the left is cut and the numbers stay', () => {
    const line = statusLine(used, 60, '(•)');
    expect(lineWidth(line)).toBeLessThanOrEqual(60);
    expect(lineText(line)).toContain('…');
    expect(lineText(line)).toEndWith('crumbs 41%  $0.01 ');
  });

  test('unknown window and no price show neither', () => {
    const state = initialState({ ...STATUS, contextWindow: null, price: null });
    const text = lineText(statusLine(state, 80, '(•)'));
    expect(text).not.toContain('crumbs');
    expect(text).not.toContain('$');
  });

  test('the meter turns jam past 85%', () => {
    const full = stateAfter([
      { type: 'usage', input: 120_000, output: 0, cacheRead: 0 },
    ]);
    const bar = statusLine(full, 100, '(•)').find((s) => s.text.includes('▰'));
    expect(bar?.fg).toBe('jam');
  });
});

describe('status helpers', () => {
  test('displayFolder shortens the home folder only', () => {
    expect(displayFolder('/home/me/code/cookie', '/home/me')).toBe(
      '~/code/cookie',
    );
    expect(displayFolder('/home/me', '/home/me')).toBe('~');
    expect(displayFolder('/home/meow/x', '/home/me')).toBe('/home/meow/x');
  });

  test('meter and cost', () => {
    expect(meter(0)).toBe('▱▱▱▱▱');
    expect(meter(0.41)).toBe('▰▰▱▱▱');
    expect(meter(1.5)).toBe('▰▰▰▰▰');
    expect(formatCost(0.384)).toBe('$0.38');
    expect(formatCost(12.34)).toBe('$12.3');
  });
});
