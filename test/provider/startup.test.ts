import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../../src/config/schema.ts';
import { createClient } from '../../src/provider/client.ts';
import { prepareProvider } from '../../src/provider/startup.ts';
import {
  errorResponse,
  fakeFetch,
  jsonResponse,
  TEST_BASE_URL,
} from '../fake-fetch.ts';

const config = configSchema.parse({
  provider: { base_url: TEST_BASE_URL, api_key_env: 'COOKIE_TEST_KEY' },
  models: { workhorse: 'ds', planner: 'luna', longctx: 'm3' },
});
const env = { COOKIE_TEST_KEY: 'sk-secret-value' };
const catalog = { data: [{ id: 'ds' }, { id: 'luna' }, { id: 'm3' }] };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cookie-startup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createClient', () => {
  test('points the SDK at the configured base URL with a bearer key', async () => {
    const fetch = fakeFetch([jsonResponse(200, catalog)]);
    const result = createClient(config.provider, { env, fetch });
    if (!result.ok) throw new Error(result.message);
    expect(result.client.baseURL).toBe(TEST_BASE_URL);
    expect(result.client.maxRetries).toBe(0);
    await result.client.get('/models');
    expect(fetch.requests[0]?.headers.get('authorization')).toBe(
      'Bearer sk-secret-value',
    );
  });

  test('a missing key names the env var but never prints a value', () => {
    const result = createClient(config.provider, { env: { OTHER: 'x' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('COOKIE_TEST_KEY is not set');
    expect(result.message).toContain('api_key_env');
  });

  test('a blank key counts as missing', () => {
    expect(
      createClient(config.provider, { env: { COOKIE_TEST_KEY: '  ' } }).ok,
    ).toBe(false);
  });
});

describe('prepareProvider', () => {
  test('succeeds when every configured model is in the catalog', async () => {
    const fetch = fakeFetch([jsonResponse(200, catalog)]);
    const result = await prepareProvider(config, {
      env,
      fetch,
      cacheFile: join(dir, 'm.json'),
    });
    expect(result.ok).toBe(true);
  });

  test('refuses to start when a configured model is missing', async () => {
    const fetch = fakeFetch([
      jsonResponse(200, { data: [{ id: 'ds' }, { id: 'luna' }] }),
    ]);
    const result = await prepareProvider(config, {
      env,
      fetch,
      cacheFile: join(dir, 'm.json'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('[models] longctx = "m3"');
  });

  test('turns a 403 into a friendly message, no stack trace', async () => {
    const fetch = fakeFetch([
      errorResponse(403, 'upgrade_required', 'Go plan has no API access'),
    ]);
    const result = await prepareProvider(config, {
      env,
      fetch,
      cacheFile: join(dir, 'm.json'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('no API access');
    expect(result.message).toContain('Go plan has no API access');
    expect(result.message).not.toContain('    at ');
    expect(result.message).not.toContain('sk-secret-value');
  });
});
