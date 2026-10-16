import { describe, expect, test } from 'bun:test';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import {
  fromHttp,
  ProviderError,
  parseRetryAfter,
  toProviderError,
} from '../../src/provider/errors.ts';

const envelope = (code: string, message = 'upstream says no') => ({
  error: { message, type: code, code, param: null },
});

describe('fromHttp', () => {
  test.each([
    [400, 'unsupported_model', 'unknown_model', false],
    [400, 'invalid_request_error', 'bad_request', false],
    [401, 'authentication_error', 'auth', false],
    [403, 'upgrade_required', 'no_api_access', false],
    [422, 'cmd_zdr_no_providers', 'zdr_unavailable', false],
    [429, 'rate_limit_error', 'rate_limit', true],
    [500, 'server_error', 'upstream', true],
    [502, 'api_error', 'upstream', true],
    [503, 'server_error', 'upstream', true],
    [404, 'not_found', 'unexpected', false],
  ] as const)('%i %s → %s', (status, code, kind, retryable) => {
    const error = fromHttp(status, envelope(code));
    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.detail).toBe('upstream says no');
  });

  test('every kind carries a single-line explanation that does not start with "Error:"', () => {
    for (const status of [400, 401, 403, 422, 429, 500, 404]) {
      const { explanation, message } = fromHttp(status, envelope('x'));
      expect(explanation).not.toContain('\n');
      expect(explanation).not.toMatch(/^Error:/);
      expect(explanation.length).toBeGreaterThan(10);
      expect(message).toBe(explanation);
    }
  });

  test('reads retry-after from headers', () => {
    const error = fromHttp(
      429,
      envelope('rate_limit_error'),
      new Headers({ 'retry-after': '3' }),
    );
    expect(error.retryAfterMs).toBe(3000);
  });

  test('tolerates bodies that are not JSON envelopes', () => {
    expect(fromHttp(502, '<html>bad gateway</html>').kind).toBe('upstream');
    expect(fromHttp(401, undefined).detail).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  test.each([
    [{ 'retry-after': '2' }, 2000],
    [{ 'retry-after': '0.5' }, 500],
    [{ 'retry-after-ms': '750' }, 750],
    [{ 'retry-after': 'Fri, 16 Oct 2026 12:00:10 GMT' }, 10_000],
    [{ 'retry-after': 'Fri, 16 Oct 2026 11:00:00 GMT' }, 0],
    [{ 'retry-after': 'soon' }, undefined],
    [{}, undefined],
  ])('%o → %p', (headers, expected) => {
    expect(parseRetryAfter(new Headers(headers), now)).toBe(expected);
  });
});

describe('toProviderError', () => {
  test('maps SDK errors by status', () => {
    const sdk = APIError.generate(
      403,
      envelope('upgrade_required').error,
      undefined,
      new Headers(),
    );
    const error = toProviderError(sdk);
    expect(error.kind).toBe('no_api_access');
    expect(error.cause).toBe(sdk);
  });

  test('maps connection failures, timeouts and aborts', () => {
    expect(
      toProviderError(new APIConnectionError({ message: 'ECONNRESET' })).kind,
    ).toBe('network');
    expect(toProviderError(new APIConnectionTimeoutError()).kind).toBe(
      'timeout',
    );
    expect(toProviderError(new APIUserAbortError()).kind).toBe('aborted');
    expect(toProviderError(new DOMException('stop', 'AbortError')).kind).toBe(
      'aborted',
    );
    expect(toProviderError(new TypeError('fetch failed')).kind).toBe('network');
  });

  test('passes ProviderErrors through and wraps anything else', () => {
    const original = new ProviderError('auth');
    expect(toProviderError(original)).toBe(original);
    const wrapped = toProviderError('boom');
    expect(wrapped.kind).toBe('unexpected');
    expect(wrapped.detail).toBe('boom');
  });
});
