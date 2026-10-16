import { ProviderError, toProviderError } from './errors.ts';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface RetryInfo {
  /** The attempt that just failed, 1-based. */
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A server asking for a longer wait than this is waited on for this long instead. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal | undefined;
  /** Injected so tests can run on a fake clock. */
  sleep?: Sleep;
  /** Injected so tests get deterministic jitter. Returns a number in [0, 1). */
  random?: () => number;
  /** Called before each wait, e.g. to show "oven busy, retrying". */
  onRetry?: (info: RetryInfo) => void;
}

export const RETRY_DEFAULTS = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
} as const;

function abortedError(signal: AbortSignal): ProviderError {
  return new ProviderError('aborted', { cause: signal.reason });
}

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      // onAbort only runs once the signal exists and has fired.
      reject(abortedError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half random,
 * so waits still grow on every attempt but parallel clients spread out.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  baseDelayMs: number = RETRY_DEFAULTS.baseDelayMs,
  maxDelayMs: number = RETRY_DEFAULTS.maxDelayMs,
): number {
  const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(window / 2 + random() * (window / 2));
}

/**
 * Runs `fn`, retrying rate limits, upstream 5xx and dropped connections with backoff.
 * Bad requests, auth and plan errors are thrown straight away.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = RETRY_DEFAULTS.maxAttempts,
    baseDelayMs = RETRY_DEFAULTS.baseDelayMs,
    maxDelayMs = RETRY_DEFAULTS.maxDelayMs,
    maxRetryAfterMs = RETRY_DEFAULTS.maxRetryAfterMs,
    signal,
    sleep = realSleep,
    random = Math.random,
    onRetry,
  } = options;

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortedError(signal);
    try {
      return await fn(attempt);
    } catch (thrown) {
      if (signal?.aborted) throw abortedError(signal);
      const error = toProviderError(thrown);
      if (!error.retryable || attempt >= maxAttempts) throw error;
      const delayMs =
        error.retryAfterMs !== undefined
          ? Math.min(error.retryAfterMs, maxRetryAfterMs)
          : backoffDelay(attempt, random, baseDelayMs, maxDelayMs);
      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
