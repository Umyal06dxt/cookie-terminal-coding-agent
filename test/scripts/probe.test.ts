import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeRecording,
  formatTable,
  PROBE_FILES,
  PROBE_TASKS,
  probeRegistry,
  readManyTool,
  tally,
  writeProbeRepo,
} from '../../scripts/lib/probe.ts';
import { failureReason } from '../../scripts/lib/record-run.ts';
import type { RecordingRecord } from '../../scripts/lib/recording.ts';
import { loadRecording } from '../../scripts/lib/recording.ts';
import { probeMain, taskIndexes } from '../../scripts/probe-quirks.ts';
import { createDefaultRegistry } from '../../src/tools/index.ts';
import { fakeFetch, jsonResponse, sseResponse } from '../fake-fetch.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';

cleanUpTempProjects();

/** A recorded response with one tool call per entry, args sent verbatim. */
function recording(
  calls: { name: string; args: string }[][],
): RecordingRecord[] {
  return calls.flatMap((turn, i) => [
    {
      t: 'request' as const,
      n: i + 1,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: [],
      body: {},
    },
    ...turn.map((call, index) => ({
      t: 'chunk' as const,
      n: i + 1,
      chunk: {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: `c${i}${index}`,
                  function: { name: call.name, arguments: call.args },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
    })),
    {
      t: 'chunk' as const,
      n: i + 1,
      chunk: {
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    },
  ]);
}

describe('probe tasks', () => {
  test('there are 12, each saying what it provokes', () => {
    expect(PROBE_TASKS).toHaveLength(12);
    for (const p of PROBE_TASKS) expect(p.provokes.length).toBeGreaterThan(5);
  });

  test('every path a task names exists in the probe repo', () => {
    const p = tempProject();
    writeProbeRepo(p.root);
    for (const rel of Object.keys(PROBE_FILES))
      expect(existsSync(p.path(rel))).toBe(true);
    for (const { task } of PROBE_TASKS) {
      for (const path of task.match(/(?:src|docs)\/[^\s,']+?\.(?:ts|md)/g) ??
        []) {
        expect(existsSync(p.path(path))).toBe(true);
      }
    }
  });

  test('read_many is a probe-only tool with an array field', async () => {
    expect(createDefaultRegistry().get('read_many')).toBeUndefined();
    expect(probeRegistry().parametersOf('read_many')).toMatchObject({
      properties: { file_paths: { type: 'array' } },
    });
    const p = tempProject();
    writeProbeRepo(p.root);
    const result = await readManyTool.run(
      { file_paths: ['src/util.ts', 'src/café/menü.ts'] },
      p.ctx(),
    );
    expect(result.output).toContain('== src/café/menü.ts');
    expect(result.output).toContain('croissant');
  });
});

describe('analyzeRecording', () => {
  test('sorts every call into valid, zod issues, invalid JSON or unknown tool', async () => {
    const verdicts = await analyzeRecording(
      recording([
        [
          { name: 'read', args: '{"file_path":"src/app.ts","limit":5}' },
          { name: 'read', args: '{"file_path":"src/app.ts","limit":"5"}' },
        ],
        [
          { name: 'read_many', args: '{"file_paths":"src/util.ts"}' },
          { name: 'read_file', args: '{"path":"a"}' },
          { name: 'glob', args: '{"pattern": ["*.md", "*.ts"]' },
        ],
        [{ name: 'read', args: '{"offset":20}' }],
      ]),
    );
    expect(verdicts).toEqual([
      { tool: 'read', issues: [] },
      { tool: 'read', issues: ['limit: invalid_type'] },
      { tool: 'read_many', issues: ['file_paths: invalid_type'] },
      { tool: 'read_file', issues: ['unknown tool'] },
      { tool: 'glob', issues: ['invalid JSON'] },
      { tool: 'read', issues: ['file_path: invalid_type'] },
    ]);
  });

  test('tally and formatTable: model × tool × valid / invalid / issues', () => {
    const rows = tally('ds-flash', [
      { tool: 'read', issues: [] },
      { tool: 'read', issues: ['limit: invalid_type'] },
      { tool: 'read', issues: ['limit: invalid_type'] },
    ]);
    tally('luna', [{ tool: 'glob', issues: [] }], rows);
    expect(formatTable(rows).split('\n')).toEqual([
      'model     tool  valid  invalid  issues',
      '────────  ────  ─────  ───────  ' +
        '─'.repeat('limit: invalid_type ×2'.length),
      'ds-flash  read  1      2        limit: invalid_type ×2',
      'luna      glob  1      0        —',
    ]);
  });
});

const SSE_TEXT = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
const CATALOG = { data: [{ id: 'fake-flash' }, { id: 'fake-luna' }] };

/** A home with a cookie.toml, and probeMain wired to fakes: nothing leaves the process. */
function probeEnv(options: { key?: boolean } = {}) {
  const p = tempProject();
  const home = join(p.root, 'home');
  mkdirSync(join(home, '.config', 'cookie'), { recursive: true });
  writeFileSync(
    join(home, '.config', 'cookie', 'cookie.toml'),
    '[models]\nworkhorse = "fake-flash"\nplanner = "fake-luna"\nlongctx = "fake-flash"\n',
  );
  let out = '';
  let err = '';
  const io = {
    cwd: p.root,
    home,
    env:
      options.key === false
        ? {}
        : { COMMANDCODE_API_KEY: 'sentinel-key-0123456789' },
    catalogCache: join(p.root, 'catalog.json'),
    outDir: join(p.root, 'recordings'),
    out: (t: string) => {
      out += t;
    },
    err: (t: string) => {
      err += t;
    },
  };
  return { p, io, output: () => ({ out, err }) };
}

describe('probeMain', () => {
  test('a config problem is reported before any run', async () => {
    const p = tempProject();
    let err = '';
    const code = await probeMain([], {
      cwd: p.root,
      home: p.root,
      err: (t) => {
        err += t;
      },
      out: () => {},
      fetch: async () => {
        throw new Error('no network in tests');
      },
    });
    expect(code).toBe(1);
    expect(err).toContain('[models]');
  });

  test('a missing API key stops it before the first run, saying how to fix it', async () => {
    const { io, output } = probeEnv({ key: false });
    const fetch = fakeFetch([]);
    const code = await probeMain([], { ...io, fetch });
    expect(code).toBe(1);
    expect(output().err).toContain(
      'COMMANDCODE_API_KEY is not set in this script',
    );
    expect(output().err).toContain('export COMMANDCODE_API_KEY=');
    expect(fetch.requests).toHaveLength(0);
    expect(existsSync(io.outDir)).toBe(false);
  });

  test('stops after 3 failed runs in a row and prints each reason', async () => {
    const { io, output } = probeEnv();
    const fetch = fakeFetch([jsonResponse(200, CATALOG)]);
    const code = await probeMain(['--model', 'not-a-model'], { ...io, fetch });
    expect(code).toBe(1);
    const { err } = output();
    expect(
      err.match(
        /✗ failed \(exit 1\): not-a-model is not in Command Code's model catalog/g,
      ),
    ).toHaveLength(3);
    expect(err).toContain('Stopped after 3 failed runs in a row');
    expect(readdirSync(join(io.outDir, 'not-a-model'))).toHaveLength(3);
    // Each recording says why it failed.
    const [first] = readdirSync(join(io.outDir, 'not-a-model'));
    const records = loadRecording(join(io.outDir, 'not-a-model', first ?? ''));
    expect(records.map((r) => r.t)).toEqual(['meta', 'exit']);
    expect(records.at(-1)).toMatchObject({
      t: 'exit',
      code: 1,
      stderr: expect.stringContaining('not in'),
    });
  });

  test('--model and --task run exactly one probe and print the table', async () => {
    const { io, output } = probeEnv();
    const fetch = fakeFetch([
      jsonResponse(200, CATALOG),
      sseResponse(SSE_TEXT),
    ]);
    const code = await probeMain(['--model', 'fake-luna', '--task', '1'], {
      ...io,
      fetch,
    });
    expect(output().err).toBe(
      'fake-luna · probe 1/12 · optional field (limit)\n',
    );
    expect(code).toBe(0);
    expect(fetch.requests).toHaveLength(2);
    expect(readdirSync(join(io.outDir, 'fake-luna'))).toEqual([
      'probe-01-read-only-the-first-5-lines-of-src-app.ts..jsonl',
    ]);
    expect(output().out).toContain('model  tool  valid  invalid  issues');
  });

  test('--task must be 1 to 12', async () => {
    const { io, output } = probeEnv();
    expect(await probeMain(['--task', '13'], io)).toBe(2);
    expect(output().err).toContain('--task must be a number from 1 to 12');
    expect(taskIndexes(['1', '12'])).toEqual([0, 11]);
    expect(taskIndexes(undefined)).toHaveLength(12);
    expect(taskIndexes(['0'])).toBeNull();
  });
});

describe('failureReason', () => {
  test("is the last thing Cookie said, without the 'cookie:' prefix", () => {
    expect(failureReason(1, 'warming up\ncookie: something broke\n\n')).toBe(
      'something broke',
    );
    expect(failureReason(1, '')).toBe('exit code 1, nothing on stderr');
  });
});
