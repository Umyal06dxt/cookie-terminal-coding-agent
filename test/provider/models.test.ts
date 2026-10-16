import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderError } from '../../src/provider/errors.ts';
import {
  CATALOG_TTL_MS,
  checkConfiguredModels,
  loadCatalog,
  ModelCatalog,
  normaliseCatalog,
} from '../../src/provider/models.ts';
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  TEST_BASE_URL,
  testClient,
} from '../fake-fetch.ts';

const CATALOG = {
  object: 'list',
  data: [
    {
      id: 'deepseek-v4.1-flash',
      object: 'model',
      context_length: 1_000_000,
      supported_endpoints: ['/chat/completions', '/messages'],
    },
    {
      id: 'gpt-5.6-luna',
      object: 'model',
      context_window: 1_100_000,
      supported_endpoints: ['/chat/completions', '/responses'],
    },
    {
      id: 'minimax-m3',
      object: 'model',
      top_provider: { context_length: 1_000_000 },
    },
    { id: 'typesafe/jev', object: 'model', supported_endpoints: ['/messages'] },
    { object: 'model' },
  ],
};

const noWait = { sleep: async () => {} };
let dir: string;
let cacheFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cookie-models-'));
  cacheFile = join(dir, 'cache', 'models.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('normaliseCatalog', () => {
  test('reads ids, context lengths under any common name, and endpoints', () => {
    const models = normaliseCatalog(CATALOG);
    expect(models.map((m) => m.id)).toEqual([
      'deepseek-v4.1-flash',
      'gpt-5.6-luna',
      'minimax-m3',
      'typesafe/jev',
    ]);
    expect(models.map((m) => m.contextLength)).toEqual([
      1_000_000,
      1_100_000,
      1_000_000,
      undefined,
    ]);
    expect(models[2]?.supportedEndpoints).toEqual([]);
  });

  test('accepts a bare array and ignores junk', () => {
    expect(normaliseCatalog([{ id: 'a' }, 7, null])).toHaveLength(1);
    expect(normaliseCatalog('nope')).toEqual([]);
  });
});

describe('loadCatalog', () => {
  const load = (fetch: ReturnType<typeof fakeFetch>, now: number) =>
    loadCatalog({
      client: testClient(fetch),
      baseUrl: TEST_BASE_URL,
      cacheFile,
      now: () => now,
      retry: noWait,
    });

  test('fetches GET /models once and exposes getModel', async () => {
    const fetch = fakeFetch([jsonResponse(200, CATALOG)]);
    const catalog = await load(fetch, 1000);
    expect(catalog.source).toBe('network');
    expect(new URL(fetch.requests[0]?.url ?? '').pathname).toBe(
      '/provider/v1/models',
    );
    expect(catalog.getModel('gpt-5.6-luna')).toEqual({
      id: 'gpt-5.6-luna',
      contextLength: 1_100_000,
      supportedEndpoints: ['/chat/completions', '/responses'],
    });
    expect(catalog.getModel('nope')).toBeUndefined();
    expect(existsSync(cacheFile)).toBe(true);
  });

  test('serves from cache within 24h without touching the network', async () => {
    await load(fakeFetch([jsonResponse(200, CATALOG)]), 0);
    const offline = fakeFetch([]);
    const catalog = await load(offline, CATALOG_TTL_MS - 1);
    expect(catalog.source).toBe('cache');
    expect(offline.requests).toHaveLength(0);
    expect(catalog.getModel('deepseek-v4.1-flash')?.contextLength).toBe(
      1_000_000,
    );
  });

  test('refetches after the TTL', async () => {
    await load(fakeFetch([jsonResponse(200, CATALOG)]), 0);
    const fetch = fakeFetch([
      jsonResponse(200, { data: [{ id: 'new-model' }] }),
    ]);
    const catalog = await load(fetch, CATALOG_TTL_MS + 1);
    expect(catalog.source).toBe('network');
    expect(catalog.ids()).toEqual(['new-model']);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).fetchedAt).toBe(
      CATALOG_TTL_MS + 1,
    );
  });

  test('falls back to an expired cache when offline', async () => {
    await load(fakeFetch([jsonResponse(200, CATALOG)]), 0);
    const offline = fakeFetch([new TypeError('fetch failed')]);
    const catalog = await load(offline, CATALOG_TTL_MS * 3);
    expect(catalog.source).toBe('stale-cache');
    expect(catalog.getModel('minimax-m3')).toBeDefined();
  });

  test('does not hide a bad key behind the cache', async () => {
    await load(fakeFetch([jsonResponse(200, CATALOG)]), 0);
    const fetch = fakeFetch([
      errorResponse(401, 'authentication_error', 'invalid key'),
    ]);
    const error = await load(fetch, CATALOG_TTL_MS * 3).catch(
      (e: unknown) => e,
    );
    expect((error as ProviderError).kind).toBe('auth');
  });

  test('ignores a cache written for another base URL', async () => {
    writeFileSync(
      join(dir, 'other.json'),
      JSON.stringify({
        version: 1,
        baseUrl: 'https://elsewhere',
        fetchedAt: 0,
        models: [],
      }),
    );
    const fetch = fakeFetch([jsonResponse(200, CATALOG)]);
    const catalog = await loadCatalog({
      client: testClient(fetch),
      baseUrl: TEST_BASE_URL,
      cacheFile: join(dir, 'other.json'),
      now: () => 1,
    });
    expect(catalog.source).toBe('network');
  });

  test('offline with no cache throws a network error after retrying', async () => {
    const fetch = fakeFetch([1, 2, 3].map(() => new TypeError('fetch failed')));
    const error = await load(fetch, 0).catch((e: unknown) => e);
    expect((error as ProviderError).kind).toBe('network');
    expect(fetch.requests).toHaveLength(3);
  });

  test('an unrecognised catalog shape is reported, not cached as empty', async () => {
    const fetch = fakeFetch([
      jsonResponse(200, { models: { a: 1 }, ok: true }),
    ]);
    const error = await load(fetch, 0).catch((e: unknown) => e);
    expect((error as ProviderError).detail).toContain(
      "wasn't recognised (top-level: models, ok)",
    );
    expect(existsSync(cacheFile)).toBe(false);
  });
});

describe('checkConfiguredModels', () => {
  const catalog = new ModelCatalog(normaliseCatalog(CATALOG), 'network');

  test('accepts models that exist and serve chat completions', () => {
    expect(
      checkConfiguredModels(catalog, {
        workhorse: 'deepseek-v4.1-flash',
        planner: 'gpt-5.6-luna',
        longctx: 'minimax-m3',
      }),
    ).toEqual({ ok: true });
  });

  test('refuses unknown ids and wrong-endpoint models, naming the key', () => {
    const result = checkConfiguredModels(catalog, {
      workhorse: 'deepseek-v4.1-lite',
      planner: 'gpt-5.6-luna',
      longctx: 'typesafe/jev',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(
      '[models] workhorse = "deepseek-v4.1-lite" is not in',
    );
    expect(result.message).toContain(
      '[models] longctx = "typesafe/jev" doesn\'t serve /chat/completions',
    );
    expect(result.message).toContain('Available models: deepseek-v4.1-flash');
  });
});
