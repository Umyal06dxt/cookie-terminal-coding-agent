import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configPaths,
  findRepoRoot,
  loadConfig,
} from '../../src/config/load.ts';

let root: string;
let home: string;
let repo: string;
let userFile: string;
let projectFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cookie-config-'));
  home = join(root, 'home');
  repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
  ({ user: userFile, project: projectFile } = configPaths({ home, cwd: repo }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(path: string, toml: string) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, toml);
}

const MODELS = `
[models]
workhorse = "deepseek-v4.1-flash"
planner = "gpt-5.6-luna"
longctx = "minimax-m3"
`;

const load = () => loadConfig({ home, cwd: join(repo, 'packages', 'api') });

function failure(): string {
  const result = load();
  if (result.ok) throw new Error('expected config loading to fail');
  return result.message;
}

describe('loadConfig', () => {
  test('finds the repo root from a nested directory', () => {
    expect(findRepoRoot(join(repo, 'packages', 'api'))).toBe(repo);
    expect(projectFile).toBe(join(repo, '.cookie', 'cookie.toml'));
    expect(userFile).toBe(join(home, '.config', 'cookie', 'cookie.toml'));
  });

  test('a valid user file fills every default', () => {
    write(userFile, MODELS);
    const result = load();
    if (!result.ok) throw new Error(result.message);
    expect(result.sources).toEqual([userFile]);
    expect(result.config).toEqual({
      provider: {
        base_url: 'https://api.commandcode.ai/provider/v1',
        api_key_env: 'COMMANDCODE_API_KEY',
      },
      models: {
        workhorse: 'deepseek-v4.1-flash',
        planner: 'gpt-5.6-luna',
        longctx: 'minimax-m3',
      },
      roles: {
        main: 'workhorse',
        explorer: 'workhorse',
        planner: 'planner',
        reviewer: 'planner',
      },
      limits: {
        max_turns: 40,
        max_parallel_tools: 8,
        request_timeout_ms: 120_000,
      },
      pricing: {},
      ui: { theme: 'auto', nerd_font: false },
    });
  });

  test('pricing per model id and ui settings are read', () => {
    write(
      userFile,
      `${MODELS}
[pricing."deepseek-v4.1-flash"]
input = 0.15
output = 0.6
cache_read = 0.003
[ui]
theme = "light"
`,
    );
    const result = load();
    if (!result.ok) throw new Error(result.message);
    expect(result.config.pricing).toEqual({
      'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cache_read: 0.003 },
    });
    expect(result.config.ui).toEqual({ theme: 'light', nerd_font: false });
  });

  test('a bad price or theme names the field', () => {
    write(
      userFile,
      `${MODELS}
[pricing.m]
input = -1
output = "cheap"
[ui]
theme = "sepia"
`,
    );
    const message = failure();
    expect(message).toContain('[pricing.m] input: must be 0 or more');
    expect(message).toContain('[pricing.m] output: must be a number');
    expect(message).toContain('[ui] theme: must be "auto", "dark" or "light"');
  });

  test('the project file overrides the user file key by key', () => {
    write(
      userFile,
      `${MODELS}\n[limits]\nmax_turns = 10\nmax_parallel_tools = 4\n`,
    );
    write(
      projectFile,
      '[models]\nplanner = "gpt-6-luna"\n[limits]\nmax_turns = 25\n[roles]\nreviewer = "longctx"\n',
    );
    const result = load();
    if (!result.ok) throw new Error(result.message);
    expect(result.sources).toEqual([userFile, projectFile]);
    expect(result.config.models).toEqual({
      workhorse: 'deepseek-v4.1-flash',
      planner: 'gpt-6-luna',
      longctx: 'minimax-m3',
    });
    expect(result.config.limits).toMatchObject({
      max_turns: 25,
      max_parallel_tools: 4,
    });
    expect(result.config.roles.reviewer).toBe('longctx');
  });

  test('a missing field is named, with both places it could go', () => {
    write(userFile, '[models]\nworkhorse = "a"\nplanner = "b"\n');
    const message = failure();
    expect(message).toContain('missing [models] longctx');
    expect(message).toContain(userFile);
    expect(message).toContain(projectFile);
  });

  test('no config files at all asks for the models table', () => {
    expect(failure()).toContain(
      'missing [models] (workhorse, planner, longctx)',
    );
  });

  test('a role pointing at an unknown model key names the file and field', () => {
    write(userFile, MODELS);
    write(projectFile, '[roles]\nreviewer = "luna"\n');
    const message = failure();
    expect(message).toContain(
      `${projectFile}: [roles] reviewer: must be one of workhorse, planner, longctx`,
    );
    expect(message).toContain('"luna"');
  });

  test('wrong types and bad limits are reported per field', () => {
    write(
      userFile,
      `${MODELS}\n[limits]\nmax_turns = "lots"\nmax_parallel_tools = 0\n[provider]\nbase_url = "not a url"\n`,
    );
    const message = failure();
    expect(message).toContain(
      `${userFile}: [limits] max_turns: must be a number`,
    );
    expect(message).toContain(
      `${userFile}: [limits] max_parallel_tools: must be greater than 0`,
    );
    expect(message).toContain(
      `${userFile}: [provider] base_url: must be a full URL`,
    );
  });

  test('a typo in a key is flagged rather than silently ignored', () => {
    write(userFile, `${MODELS}\n[limits]\nmax_turn = 5\n`);
    expect(failure()).toContain(`${userFile}: unknown key [limits] max_turn`);
  });

  test('invalid TOML names the file, line and column, without a stack trace', () => {
    write(userFile, MODELS);
    write(projectFile, '[limits]\nmax_turns = = 3\n');
    const message = failure();
    expect(message).toStartWith(`${projectFile}:2:`);
    expect(message).toContain('is not valid TOML');
    expect(message).not.toContain('    at ');
  });
});
