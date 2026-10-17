import { expect, test } from 'bun:test';
import { interruptHandler } from '../../src/headless/main.ts';

test('first Ctrl-C aborts the run, the second exits at once', () => {
  const controller = new AbortController();
  let exits = 0;
  const onSigint = interruptHandler(controller, () => {
    exits++;
  });
  onSigint();
  expect(controller.signal.aborted).toBe(true);
  expect(exits).toBe(0);
  onSigint();
  expect(exits).toBe(1);
});
