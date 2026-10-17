import { describe, expect, test } from 'bun:test';
import { LineCapper } from '../../src/tools/output-cap.ts';

describe('LineCapper', () => {
  test('keeps everything when under the cap, across split chunks', () => {
    const c = new LineCapper(2, 3);
    c.push('al');
    c.push('pha\nbe');
    c.push('ta\r\ngamma');
    c.end();
    expect(c.render()).toBe('alpha\nbeta\ngamma');
    expect(c.dropped).toBe(0);
  });

  test('keeps the head and tail and counts what was dropped', () => {
    const c = new LineCapper(100, 200);
    c.push(Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n'));
    c.end();
    const out = c.render().split('\n');
    expect(out).toHaveLength(301);
    expect(out[0]).toBe('line 1');
    expect(out[99]).toBe('line 100');
    expect(out[100]).toBe('… 700 lines dropped …');
    expect(out[101]).toBe('line 801');
    expect(out.at(-1)).toBe('line 1000');
    expect(c.lineCount).toBe(1000);
  });

  test('bounds a single endless line', () => {
    const c = new LineCapper(1, 1, 10);
    for (let i = 0; i < 1000; i++) c.push('yyyyyyyyyy');
    c.end();
    expect(c.render().length).toBeLessThanOrEqual(11);
  });
});
