import { describe, expect, test } from 'bun:test';
import { fromHttp, ProviderError } from '../../src/provider/errors.ts';
import {
  backoffDelay,
  realSleep,
  withRetry,
} from '../../src/provider/retry.ts';

/** A clock that only moves when a retry sleeps, so timing is exact and tests are instant. */
class FakeClock {
  now = 0;
  readonly waits: number[] = [];
  sleep = async (ms: number, signal?: AbortSignal) => {
    if (signal?.aborted) throw new ProviderError('aborted');
    this.waits.push(ms);
    this.now += ms;
  };
}

const status = (code: number, headers?: Record<string, string>) =>
  fromHttp(code, { error: { message: 'x', code: 'x' } }, new Headers(headers));

/** Fails with each error in turn, then returns 'ok'. */
function failThen(...errors: unknown[]) {
  const attempts: number[] = [];
  const fn = async (attempt: number) => {
    attempts.push(attempt);
    const next = errors.shift();
    if (next !== undefined) throw next;
    return 'ok';
  };
  return { fn, attempts };
}

describe('backoffDelay', () => {
  test('doubles each attempt with jitter in the upper half of the window', () => {
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, () => 0))).toEqual([
      250, 500, 1000, 2000,
    ]);
    expect([1, 2, 3, 4].map((a) => backoffDelay(a, () => 0.999999))).toEqual([
      500, 1000, 2000, 4000,
    ]);
  });

  test('is capped at maxDelayMs', () => {
    expect(backoffDelay(20, () => 1, 500, 30_000)).toBe(30_000);
  });
});

describe('withRetry', () => {
  test('retries 429 and 5xx with exponential backoff, then succeeds', async () => {
    const clock = new FakeClock();
    const { fn, attempts } = failThen(status(429), status(500), status(503));
    const result = await withRetry(fn, {
      sleep: clock.sleep,
      random: () => 0.5,
    });
    expect(result).toBe('ok');
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(clock.waits).toEqual([375, 750, 1500]);
    expect(clock.now).toBe(2625);
  });

  test('honours retry-after instead of the backoff', async () => {
    const clock = new FakeClock();
    const { fn } = failThen(status(429, { 'retry-after': '7' }), status(503));
    await withRetry(fn, { sleep: clock.sleep, random: () => 0 });
    expect(clock.waits).toEqual([7000, 500]);
  });

  test('caps an absurd retry-after', async () => {
    const clock = new FakeClock();
    const { fn } = failThen(status(429, { 'retry-after': '86400' }));
    await withRetry(fn, { sleep: clock.sleep, maxRetryAfterMs: 60_000 });
    expect(clock.waits).toEqual([60_000]);
  });

  test('gives up after 5 attempts and throws the last error', async () => {
    const clock = new FakeClock();
    const { fn, attempts } = failThen(
      ...Array.from({ length: 10 }, () => status(502)),
    );
    const error = await withRetry(fn, { sleep: clock.sleep }).catch(
      (e: unknown) => e,
    );
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(clock.waits).toHaveLength(4);
    expect((error as ProviderError).kind).toBe('upstream');
  });

  test.each([400, 401, 403, 422])('never retries %i', async (code) => {
    const clock = new FakeClock();
    const { fn, attempts } = failThen(status(code));
    const error = await withRetry(fn, { sleep: clock.sleep }).catch(
      (e: unknown) => e,
    );
    expect(attempts).toEqual([1]);
    expect(clock.waits).toEqual([]);
    expect((error as ProviderError).status).toBe(code);
  });

  test('reports each retry so the UI can say "oven busy"', async () => {
    const clock = new FakeClock();
    const seen: string[] = [];
    const { fn } = failThen(status(429));
    await withRetry(fn, {
      sleep: clock.sleep,
      random: () => 0,
      onRetry: ({ attempt, delayMs, error }) =>
        seen.push(`${attempt}:${delayMs}:${error.kind}`),
    });
    expect(seen).toEqual(['1:250:rate_limit']);
  });

  test('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fn, attempts } = failThen();
    const error = await withRetry(fn, { signal: controller.signal }).catch(
      (e: unknown) => e,
    );
    expect((error as ProviderError).kind).toBe('aborted');
    expect(attempts).toEqual([]);
  });

  test('an abort during the backoff wait stops retrying', async () => {
    const controller = new AbortController();
    const { fn, attempts } = failThen(status(503), status(503));
    const pending = withRetry(fn, {
      signal: controller.signal,
      // A real timer far longer than the test; the abort must cut it short.
      sleep: realSleep,
      baseDelayMs: 60_000,
    });
    queueMicrotask(() => controller.abort());
    const error = await pending.catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('aborted');
    expect(attempts).toEqual([1]);
  });
});
