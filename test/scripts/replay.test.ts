import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeProbeRepo } from '../../scripts/lib/probe.ts';
import { recordMain } from '../../scripts/record.ts';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/agent/session.ts';
import { createDefaultRegistry } from '../../src/tools/index.ts';
import { fakeFetch, jsonResponse, sseResponse } from '../fake-fetch.ts';
import {
  loadRecording,
  type RecordingRecord,
  replayModel,
} from '../fake-model.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';

cleanUpTempProjects();

const SENTINEL = 'sentinel-key-do-not-record-0123456789';
const sse = (chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

/** Turn 1 reads src/util.ts; turn 2 answers. */
const TURNS = [
  sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_r1',
                type: 'function',
                function: { name: 'read', arguments: '{"file_' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'path":"src/util.ts"}' } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } },
  ]),
  sse([
    {
      choices: [
        {
          index: 0,
          delta: { content: 'util.ts exports ' },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { content: 'foo and fooAgain.' },
          finish_reason: 'stop',
        },
      ],
    },
  ]),
];

/** Records a two-turn run through scripts/record.ts with every outside call faked. */
async function record(): Promise<{
  file: string;
  records: RecordingRecord[];
  fetch: ReturnType<typeof fakeFetch>;
}> {
  const p = tempProject();
  const home = join(p.root, 'home');
  mkdirSync(join(home, '.config', 'cookie'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'cookie', 'cookie.toml'),
    '[models]\nworkhorse = "fake-flash"\nplanner = "fake-luna"\nlongctx = "fake-m3"\n',
  );
  const repo = join(p.root, 'repo');
  mkdirSync(repo);
  writeProbeRepo(repo);
  const fetch = fakeFetch([
    jsonResponse(200, {
      data: [{ id: 'fake-flash' }, { id: 'fake-luna' }, { id: 'fake-m3' }],
    }),
    sseResponse(TURNS[0] ?? ''),
    sseResponse(TURNS[1] ?? ''),
  ]);
  const outDir = join(p.root, 'recordings');
  const code = await recordMain(
    [
      '--model',
      'fake-flash',
      '--task',
      'What does src/util.ts export?',
      '--repo',
      repo,
    ],
    {
      env: { COMMANDCODE_API_KEY: SENTINEL },
      fetch,
      home,
      catalogCache: join(p.root, 'catalog.json'),
      outDir,
      out: () => {},
      err: () => {},
    },
  );
  expect(code).toBe(0);
  const file = join(outDir, 'fake-flash', 'what-does-src-util.ts-export.jsonl');
  return { file, records: loadRecording(file), fetch };
}

/** Replays a recording through the real loop and real tools in a fresh copy of the probe repo. */
async function replay(
  records: RecordingRecord[],
  task = 'What does src/util.ts export?',
  options = {},
) {
  const p = tempProject();
  writeProbeRepo(p.root);
  const model = replayModel(records, { onMismatch: 'collect', ...options });
  const session = new Session([
    {
      role: 'system',
      content: 'a different system prompt: dates and paths differ at replay',
    },
    { role: 'user', content: task },
  ]);
  const reason = await runAgent({
    session,
    tools: createDefaultRegistry().forAgent({
      projectRoot: p.root,
      readLedger: new Map(),
    }),
    model: 'fake-flash',
    stream: model,
  });
  return { model, reason, session };
}

describe('scripts/record.ts end to end (no network)', () => {
  test('writes meta, both requests and every chunk, with no key anywhere', async () => {
    const { file, records, fetch } = await record();
    expect(records[0]).toMatchObject({
      t: 'meta',
      model: 'fake-flash',
      task: 'What does src/util.ts export?',
      yes: true,
    });
    expect(records.filter((r) => r.t === 'request')).toHaveLength(2);
    expect(records.filter((r) => r.t === 'chunk')).toHaveLength(6);
    expect(readFileSync(file, 'utf8')).not.toContain(SENTINEL);
    // The run really went through cookie -p: the second request carries the read result.
    const second = records.find((r) => r.t === 'request' && r.n === 2);
    expect(JSON.stringify(second)).toContain('fooAgain');
    expect(fetch.requests).toHaveLength(3);
    expect(records.at(-1)).toEqual({
      t: 'exit',
      code: 0,
      stderr: expect.any(String),
    });
  });
});

test('a model the catalog does not list fails clearly before any chat request', async () => {
  const p = tempProject();
  const home = join(p.root, 'home');
  mkdirSync(join(home, '.config', 'cookie'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'cookie', 'cookie.toml'),
    '[models]\nworkhorse = "fake-flash"\nplanner = "fake-flash"\nlongctx = "fake-flash"\n',
  );
  const repo = join(p.root, 'repo');
  mkdirSync(repo);
  let err = '';
  const fetch = fakeFetch([
    jsonResponse(200, { data: [{ id: 'fake-flash' }] }),
  ]);
  const code = await recordMain(
    ['--model', 'gpt-imaginary', '--task', 'x', '--repo', repo],
    {
      env: { COMMANDCODE_API_KEY: SENTINEL },
      fetch,
      home,
      catalogCache: join(p.root, 'catalog.json'),
      outDir: join(p.root, 'out'),
      err: (t) => {
        err += t;
      },
    },
  );
  expect(code).toBe(1);
  expect(err).toContain("gpt-imaginary is not in Command Code's model catalog");
  expect(fetch.requests).toHaveLength(1);
});

describe('replayModel', () => {
  test('replays a recording turn by turn through the real chunk parser', async () => {
    const { records } = await record();
    const { model, reason, session } = await replay(records);
    expect(reason).toBe('done');
    expect(model.mismatches).toEqual([]);
    model.assertDone();
    expect(session.messages.at(-1)).toEqual({
      role: 'assistant',
      content: 'util.ts exports foo and fooAgain.',
    });
  });

  test('a different request is a mismatch naming the field, expected and actual', async () => {
    const { records } = await record();
    const { model, reason } = await replay(
      records,
      'What does src/app.ts export?',
    );
    expect(reason).toBe('error');
    expect(model.mismatches[0]).toContain(
      'request #1 differs from the recording',
    );
    expect(model.mismatches[0]).toContain(
      'messages[1].content: expected "What does src/util.ts export?", got "What does src/app.ts export?"',
    );
    expect(() => model.assertDone()).toThrow('differs');
  });

  test('one request too many is a mismatch', async () => {
    const { records } = await record();
    const firstOnly = records.filter((r) => !('n' in r) || r.n === 1);
    const { model } = await replay(firstOnly);
    expect(model.mismatches[0]).toContain(
      'the loop sent request #2, but the recording has only 1',
    );
  });

  test('stopping early fails assertDone', async () => {
    const { records } = await record();
    const model = replayModel(records, { onMismatch: 'collect' });
    expect(model.remaining()).toBe(2);
    expect(() => model.assertDone()).toThrow(
      'the loop stopped after 0 request(s); the recording has 2',
    );
  });

  test('the system prompt is ignored unless asked for', async () => {
    const { records } = await record();
    const { model } = await replay(records, undefined, { compareSystem: true });
    expect(model.mismatches[0]).toContain('messages[0].content');
  });

  test('a recorded HTTP error replays as the same ProviderError', async () => {
    const records: RecordingRecord[] = [
      {
        t: 'request',
        n: 1,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: [],
        body: { model: 'fake-flash', messages: [] },
      },
      { t: 'response', n: 1, status: 429, headers: [] },
      {
        t: 'error',
        n: 1,
        body: { error: { message: 'slow down', code: 'rate_limited' } },
      },
    ];
    const model = replayModel(records, { onMismatch: 'collect' });
    const stream = model({ model: 'fake-flash', messages: [] });
    await expect(
      (async () => {
        for await (const _ of stream) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({
      kind: 'rate_limit',
      status: 429,
    });
  });

  test('by default a mismatch fails loudly even though the loop swallows stream errors', () => {
    const script = join(import.meta.dir, 'replay-mismatch.script.ts');
    const result = Bun.spawnSync([process.execPath, script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'replayModel: request #1 differs from the recording',
    );
    expect(result.stderr.toString()).toContain('messages[1].content');
  });
});
