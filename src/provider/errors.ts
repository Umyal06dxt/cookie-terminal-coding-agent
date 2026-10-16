import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';

export type ProviderErrorKind =
  | 'unknown_model'
  | 'bad_request'
  | 'auth'
  | 'no_api_access'
  | 'zdr_unavailable'
  | 'rate_limit'
  | 'upstream'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'unexpected';

/** One line each, written for the person at the terminal. */
const EXPLANATIONS: Record<ProviderErrorKind, string> = {
  unknown_model:
    "Command Code doesn't know this model id; check [models] in cookie.toml against the catalog.",
  bad_request:
    "Command Code rejected the request: the body is malformed or this model doesn't serve this endpoint.",
  auth: 'Command Code rejected the API key; check the variable named by [provider] api_key_env.',
  no_api_access:
    'This Command Code plan has no API access; the Pro or Provider plan is needed.',
  zdr_unavailable:
    'No zero-data-retention upstream serves this model; turn off ZDR or pick another model.',
  rate_limit:
    'The oven is busy: Command Code is rate limiting requests. Retrying shortly.',
  upstream: "The model's upstream provider failed; this is usually temporary.",
  network: "Couldn't reach Command Code; check your connection.",
  timeout: 'The request to Command Code timed out.',
  aborted: 'The request was cancelled.',
  unexpected: 'Command Code returned an unexpected error.',
};

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'upstream',
  'network',
]);

export interface ProviderErrorInit {
  status?: number | undefined;
  /** The provider's own message, if it sent one. Shown as detail, never instead of the explanation. */
  detail?: string | undefined;
  retryAfterMs?: number | undefined;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly detail: string | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: ProviderErrorKind, init: ProviderErrorInit = {}) {
    super(EXPLANATIONS[kind], { cause: init.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = init.status;
    this.detail = init.detail;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** The one-line, user-facing explanation. */
  get explanation(): string {
    return EXPLANATIONS[this.kind];
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** Parses `retry-after-ms`, or `retry-after` as seconds or an HTTP date, into milliseconds. */
export function parseRetryAfter(
  headers: Headers | undefined,
  now: number = Date.now(),
): number | undefined {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function kindForStatus(
  status: number,
  code: string | undefined,
): ProviderErrorKind {
  if (status === 400)
    return code === 'unsupported_model' ? 'unknown_model' : 'bad_request';
  if (status === 401) return 'auth';
  if (status === 403) return 'no_api_access';
  if (status === 422) return 'zdr_unavailable';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream';
  return 'unexpected';
}

/**
 * Builds a ProviderError from an HTTP status and the parsed `error` object of an
 * OpenAI-style envelope (`{ error: { message, type, code } }`), or the envelope itself.
 */
export function fromHttp(
  status: number,
  body: unknown,
  headers?: Headers,
  now?: number,
): ProviderError {
  const inner =
    typeof body === 'object' && body !== null && 'error' in body
      ? body.error
      : body;
  const code = field(inner, 'code');
  const detail = field(inner, 'message')?.slice(0, 300);
  return new ProviderError(kindForStatus(status, code), {
    status,
    detail,
    retryAfterMs: parseRetryAfter(headers, now),
  });
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Normalises anything thrown by the SDK or fetch into a ProviderError. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (
    error instanceof APIConnectionTimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  ) {
    return new ProviderError('timeout', { cause: error });
  }
  if (isAbort(error)) return new ProviderError('aborted', { cause: error });
  if (error instanceof APIConnectionError) {
    return new ProviderError('network', { cause: error });
  }
  if (error instanceof APIError) {
    // No status means the SDK read an `error` event inside a 200 stream: the upstream failed midway.
    if (error.status === undefined) {
      return new ProviderError('upstream', {
        detail: field(error.error, 'message')?.slice(0, 300),
        cause: error,
      });
    }
    const fromBody = fromHttp(error.status, error.error, error.headers);
    return new ProviderError(fromBody.kind, {
      status: fromBody.status,
      detail: fromBody.detail,
      retryAfterMs: fromBody.retryAfterMs,
      cause: error,
    });
  }
  if (error instanceof TypeError)
    return new ProviderError('network', { cause: error });
  return new ProviderError('unexpected', {
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}
