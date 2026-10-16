import OpenAI from 'openai';
import type { CookieConfig } from '../config/schema.ts';

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ClientOptions {
  /** Where to read the key from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Injected in tests so nothing touches the network. */
  fetch?: FetchLike;
}

export type ClientResult =
  | { ok: true; client: OpenAI }
  | { ok: false; message: string };

/**
 * Builds the OpenAI SDK client pointed at Command Code. The key is read from the env var
 * named in config and handed straight to the SDK; it is never returned, logged or echoed.
 */
export function createClient(
  provider: CookieConfig['provider'],
  options: ClientOptions = {},
): ClientResult {
  const env = options.env ?? process.env;
  const varName = provider.api_key_env;
  const apiKey = env[varName]?.trim();
  if (!apiKey) {
    return {
      ok: false,
      message:
        `Cookie needs a Command Code API key, but ${varName} is not set.\n` +
        `Export ${varName} in your shell, or point [provider] api_key_env in cookie.toml at the variable that holds it.`,
    };
  }
  const client = new OpenAI({
    apiKey,
    baseURL: provider.base_url,
    // Retries are ours (retry.ts) so they honour retry-after, abort signals and the UI line.
    maxRetries: 0,
    ...(options.timeoutMs !== undefined && { timeout: options.timeoutMs }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });
  return { ok: true, client };
}
