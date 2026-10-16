#!/usr/bin/env bun
/**
 * Manual smoke test: ONE real streamed call to the workhorse model. Costs a fraction of a cent.
 * Run by hand with `bun scripts/smoke.ts`; never from tests or CI.
 */
import { loadConfig } from '../src/config/load.ts';
import { ProviderError } from '../src/provider/errors.ts';
import { prepareProvider } from '../src/provider/startup.ts';
import { streamChat } from '../src/provider/stream.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const loaded = loadConfig();
if (!loaded.ok) fail(loaded.message);
const { config } = loaded;

const setup = await prepareProvider(config);
if (!setup.ok) fail(setup.message);

const model = config.models.workhorse;
const info = setup.catalog.getModel(model);
process.stderr.write(
  `catalog: ${setup.catalog.source} · model: ${model} · context: ${info?.contextLength ?? 'unknown'}\n\n`,
);

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());

try {
  for await (const event of streamChat({
    client: setup.client,
    model,
    messages: [
      { role: 'user', content: 'Say hello from Cookie in one short sentence.' },
    ],
    signal: controller.signal,
    retry: {
      onRetry: ({ attempt, delayMs, error }) =>
        process.stderr.write(
          `\n[retry ${attempt}] ${error.explanation} (waiting ${delayMs} ms)\n`,
        ),
    },
  })) {
    if (event.type === 'text_delta') process.stdout.write(event.text);
    else if (event.type === 'usage') {
      process.stderr.write(
        `\n\nusage: ${event.input} in · ${event.output} out · ${event.cacheRead} cache read\n`,
      );
    } else if (event.type === 'done')
      process.stderr.write(`finish: ${event.finishReason}\n`);
  }
} catch (error) {
  if (error instanceof ProviderError) {
    fail(
      `\n${error.explanation}${error.detail ? `\n  (${error.detail})` : ''}`,
    );
  }
  throw error;
}
