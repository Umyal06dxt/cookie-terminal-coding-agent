import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type OpenAI from 'openai';
import type { CookieConfig } from '../config/schema.ts';
import { ProviderError, toProviderError } from './errors.ts';
import { type RetryOptions, withRetry } from './retry.ts';

export interface ModelInfo {
  id: string;
  /** Undefined when the catalog doesn't say. */
  contextLength: number | undefined;
  /** Empty when the catalog doesn't say. */
  supportedEndpoints: string[];
}

export type CatalogSource = 'network' | 'cache' | 'stale-cache';

interface CacheFile {
  version: 1;
  baseUrl: string;
  fetchedAt: number;
  models: ModelInfo[];
}

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT_WITH_CACHE_MS = 10_000;

export function defaultCachePath(home: string = homedir()): string {
  return join(home, '.cache', 'cookie', 'models.json');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Reads a `GET /models` body. The Command Code docs don't pin the field names for the context
 * window, so the common spellings are all accepted; unknown entries are skipped, not fatal.
 */
export function normaliseCatalog(body: unknown): ModelInfo[] {
  const list = Array.isArray(body) ? body : record(body)?.data;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): ModelInfo[] => {
    const entry = record(raw);
    if (!entry || typeof entry.id !== 'string' || entry.id === '') return [];
    const endpoints = Array.isArray(entry.supported_endpoints)
      ? entry.supported_endpoints.filter(
          (e): e is string => typeof e === 'string',
        )
      : [];
    return [
      {
        id: entry.id,
        contextLength:
          positive(entry.context_length) ??
          positive(entry.context_window) ??
          positive(entry.max_context_length) ??
          positive(record(entry.top_provider)?.context_length),
        supportedEndpoints: endpoints,
      },
    ];
  });
}

export class ModelCatalog {
  private readonly byId: Map<string, ModelInfo>;

  constructor(
    models: readonly ModelInfo[],
    readonly source: CatalogSource,
  ) {
    this.byId = new Map(models.map((m) => [m.id, m]));
  }

  getModel(id: string): ModelInfo | undefined {
    return this.byId.get(id);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }
}

function readCache(path: string): CacheFile | undefined {
  try {
    const parsed = record(JSON.parse(readFileSync(path, 'utf8')));
    if (
      parsed?.version === 1 &&
      typeof parsed.baseUrl === 'string' &&
      typeof parsed.fetchedAt === 'number' &&
      Array.isArray(parsed.models)
    ) {
      return {
        version: 1,
        baseUrl: parsed.baseUrl,
        fetchedAt: parsed.fetchedAt,
        models: parsed.models.flatMap((raw: unknown): ModelInfo[] => {
          const m = record(raw);
          if (!m || typeof m.id !== 'string') return [];
          const endpoints = Array.isArray(m.supportedEndpoints)
            ? m.supportedEndpoints
            : [];
          return [
            {
              id: m.id,
              contextLength: positive(m.contextLength),
              supportedEndpoints: endpoints.filter(
                (e): e is string => typeof e === 'string',
              ),
            },
          ];
        }),
      };
    }
  } catch {
    // Missing or corrupt cache: behave as if there is none.
  }
  return undefined;
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A read-only home directory shouldn't stop Cookie; the catalog is just refetched next time.
  }
}

export interface CatalogOptions {
  client: OpenAI;
  baseUrl: string;
  cacheFile?: string;
  ttlMs?: number;
  now?: () => number;
  signal?: AbortSignal;
  retry?: RetryOptions;
}

/** Fetches the catalog at most once per TTL; falls back to an expired cache when offline. */
export async function loadCatalog(
  options: CatalogOptions,
): Promise<ModelCatalog> {
  const { client, baseUrl, signal } = options;
  const cacheFile = options.cacheFile ?? defaultCachePath();
  const now = (options.now ?? Date.now)();
  const cached = readCache(cacheFile);
  const usable = cached?.baseUrl === baseUrl ? cached : undefined;

  if (usable && now - usable.fetchedAt < (options.ttlMs ?? CATALOG_TTL_MS)) {
    return new ModelCatalog(usable.models, 'cache');
  }

  let body: unknown;
  try {
    body = await withRetry(
      () =>
        client.get<unknown>('/models', {
          // With a cache to fall back on, a hanging connection shouldn't hold up startup.
          ...(usable && { timeout: CATALOG_TIMEOUT_WITH_CACHE_MS }),
          ...(signal && { signal }),
        }),
      {
        // With a cache to fall back on, don't keep the user waiting on a dead connection.
        maxAttempts: usable ? 1 : 3,
        ...options.retry,
        signal,
      },
    );
  } catch (thrown) {
    const error: ProviderError = toProviderError(thrown);
    const fatal =
      error.kind === 'auth' ||
      error.kind === 'no_api_access' ||
      error.kind === 'aborted';
    if (usable && !fatal) return new ModelCatalog(usable.models, 'stale-cache');
    throw error;
  }

  const models = normaliseCatalog(body);
  if (models.length === 0) {
    // Caching this would make every configured model look "missing" for a day; blame the parser instead.
    const keys = record(body)
      ? Object.keys(body as object).join(', ')
      : typeof body;
    throw new ProviderError('unexpected', {
      detail: `the model catalog response wasn't recognised (top-level: ${keys || 'empty'})`,
    });
  }
  writeCache(cacheFile, { version: 1, baseUrl, fetchedAt: now, models });
  return new ModelCatalog(models, 'network');
}

const CHAT_ENDPOINT = /chat[/_.-]?completions/i;

/** Refuses configured model ids that aren't in the catalog or can't serve chat completions. */
export function checkConfiguredModels(
  catalog: ModelCatalog,
  models: CookieConfig['models'],
): { ok: true } | { ok: false; message: string } {
  const problems: string[] = [];
  for (const [key, id] of Object.entries(models)) {
    const info = catalog.getModel(id);
    if (!info) {
      problems.push(
        `[models] ${key} = "${id}" is not in Command Code's model catalog`,
      );
    } else if (
      info.supportedEndpoints.length > 0 &&
      !info.supportedEndpoints.some((e) => CHAT_ENDPOINT.test(e))
    ) {
      problems.push(
        `[models] ${key} = "${id}" doesn't serve /chat/completions (it serves ${info.supportedEndpoints.join(', ')})`,
      );
    }
  }
  if (problems.length === 0) return { ok: true };
  const available = catalog.ids();
  const hint =
    available.length > 0
      ? `\nAvailable models: ${available.slice(0, 15).join(', ')}${available.length > 15 ? ', …' : ''}`
      : '';
  return {
    ok: false,
    message: `Cookie can't start with this model config:\n${problems.map((p) => `  - ${p}`).join('\n')}${hint}`,
  };
}
