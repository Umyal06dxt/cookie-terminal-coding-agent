import type OpenAI from 'openai';
import type { CookieConfig } from '../config/schema.ts';
import { type ClientOptions, createClient } from './client.ts';
import { toProviderError } from './errors.ts';
import {
  checkConfiguredModels,
  loadCatalog,
  type ModelCatalog,
} from './models.ts';

export type ProviderSetup =
  | { ok: true; client: OpenAI; catalog: ModelCatalog }
  | { ok: false; message: string };

export interface StartupOptions extends ClientOptions {
  cacheFile?: string;
  signal?: AbortSignal;
}

/**
 * Everything the provider needs before the first turn: a client, the model catalog, and a
 * check that every configured model exists. Returns a message to print instead of throwing.
 */
export async function prepareProvider(
  config: CookieConfig,
  options: StartupOptions = {},
): Promise<ProviderSetup> {
  const created = createClient(config.provider, {
    timeoutMs: config.limits.request_timeout_ms,
    ...options,
  });
  if (!created.ok) return created;

  let catalog: ModelCatalog;
  try {
    catalog = await loadCatalog({
      client: created.client,
      baseUrl: config.provider.base_url,
      ...(options.cacheFile !== undefined && { cacheFile: options.cacheFile }),
      ...(options.signal !== undefined && { signal: options.signal }),
    });
  } catch (thrown) {
    const error = toProviderError(thrown);
    const detail = error.detail ? `\n  (${error.detail})` : '';
    return {
      ok: false,
      message: `Cookie couldn't load the model catalog. ${error.explanation}${detail}`,
    };
  }

  const check = checkConfiguredModels(catalog, config.models);
  if (!check.ok) return check;
  return { ok: true, client: created.client, catalog };
}
