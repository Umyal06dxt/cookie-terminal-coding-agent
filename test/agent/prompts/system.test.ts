import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSystemPrompt,
  CORE_RULES,
  collectEnvironment,
  gitBranch,
  localDate,
  type PromptEnvironment,
} from '../../../src/agent/prompts/system.ts';
import { createDefaultRegistry } from '../../../src/tools/index.ts';
import { cleanUpTempProjects, tempProject } from '../../tools/helpers.ts';

cleanUpTempProjects();

const tools = createDefaultRegistry()
  .schemas()
  .flatMap((t) => (t.type === 'function' ? [t.function] : []))
  .map((f) => ({ name: f.name, description: f.description ?? '' }));

const envA: PromptEnvironment = {
  os: 'linux 6.8.0 (x64)',
  shell: 'bash',
  projectRoot: '/work/cookie',
  gitBranch: 'main',
  date: '2026-10-17',
};
const envB: PromptEnvironment = {
  os: 'darwin 24.1.0 (arm64)',
  shell: 'zsh',
  projectRoot: '/Users/someone/elsewhere',
  gitBranch: 'detached at 1a2b3c4',
  date: '2027-01-01',
};

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ['git', '-c', 'user.email=cookie@test', '-c', 'user.name=cookie', ...args],
    { cwd, stdout: 'ignore', stderr: 'ignore' },
  );
  expect(result.exitCode).toBe(0);
}

describe('system prompt', () => {
  // The static part is the provider cache prefix. If this snapshot changes, every cached
  // prefix is invalidated: update it on purpose with `bun test --update-snapshots`.
  test('the static part matches the snapshot', () => {
    expect(buildSystemPrompt(tools, envA).static).toMatchSnapshot();
  });

  test('the static part is byte-identical whatever the environment', () => {
    const a = buildSystemPrompt(tools, envA);
    const b = buildSystemPrompt(tools, envB);
    expect(a.static).toBe(b.static);
    expect(a.dynamic).not.toBe(b.dynamic);
  });

  test('dynamic values come last, after the rules and the tool list', () => {
    const prompt = buildSystemPrompt(tools, envA);
    expect(prompt.text).toBe(prompt.static + prompt.dynamic);
    expect(prompt.text.startsWith(CORE_RULES)).toBe(true);
    expect(prompt.dynamic).toBe(
      [
        'Environment',
        '- OS: linux 6.8.0 (x64)',
        '- Shell: bash',
        '- Project root: /work/cookie',
        '- Git branch: main',
        "- Today's date: 2026-10-17",
        '',
      ].join('\n'),
    );
    for (const value of [envA.os, envA.projectRoot, envA.date])
      expect(prompt.static).not.toContain(value);
  });

  test('lists every tool in registry order with its description', () => {
    const { static: text } = buildSystemPrompt(tools, envA);
    const listed = [...text.matchAll(/^- (\w+): /gm)].map((m) => m[1]);
    expect(listed).toEqual(['read', 'glob', 'edit', 'write', 'bash']);
    for (const t of tools)
      expect(text).toContain(`- ${t.name}: ${t.description}\n`);
  });

  test('says so when there are no tools', () => {
    expect(buildSystemPrompt([], envA).static).toContain('Tools\n- none\n');
  });

  test('the core rules are the draft in docs/design.md, verbatim', () => {
    const doc = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'docs', 'design.md'),
      'utf8',
    );
    const draft =
      /\*\*System prompt draft \(core rules\)\*\*\s*```markdown\n([\s\S]*?)\n```/.exec(
        doc,
      )?.[1];
    expect(draft).toBe(CORE_RULES);
  });
});

describe('environment', () => {
  test('localDate uses the local calendar day, zero-padded', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDate(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  test('gitBranch: a fresh repo with no commits still has its branch', () => {
    const p = tempProject();
    git(p.root, 'init', '-q', '-b', 'shortbread');
    expect(gitBranch(p.root)).toBe('shortbread');
  });

  test('gitBranch: a detached HEAD shows the commit', () => {
    const p = tempProject();
    git(p.root, 'init', '-q', '-b', 'main');
    git(p.root, 'commit', '-q', '--allow-empty', '-m', 'first');
    git(p.root, 'checkout', '-q', '--detach');
    expect(gitBranch(p.root)).toMatch(/^detached at [0-9a-f]{4,}$/);
  });

  test('gitBranch: outside a repo it says so', () => {
    const p = tempProject();
    expect(gitBranch(p.root)).toBe('not a git repository');
  });

  test('collectEnvironment fills every field', () => {
    const p = tempProject();
    const env = collectEnvironment(p.root, new Date(2026, 9, 17));
    expect(env.projectRoot).toBe(p.root);
    expect(env.date).toBe('2026-10-17');
    expect(env.os).toContain(process.platform);
    expect(env.shell).not.toBe('');
    expect(env.gitBranch).toBe('not a git repository');
  });
});
