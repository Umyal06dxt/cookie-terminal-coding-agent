import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import type { AgentEvent } from '../../src/agent/events.ts';
import {
  localDate,
  type PromptEnvironment,
} from '../../src/agent/prompts/system.ts';
import { runHeadless } from '../../src/headless/run.ts';
import { ProviderError } from '../../src/provider/errors.ts';
import { NEEDS_APPROVAL } from '../../src/safety/permissions.ts';
import { fakeModel, type ScriptedTurn } from '../fake-model.ts';
import { tempProject, useTempProjects } from '../tools/helpers.ts';

useTempProjects();

const MATH =
  'export function add(a: number, b: number) {\n  return a - b;\n}\n';

const ENV: PromptEnvironment = {
  os: 'linux test',
  shell: 'bash',
  projectRoot: '/repo',
  gitBranch: 'main',
  date: '2026-10-17',
};

async function headless(
  script: ScriptedTurn[],
  options: {
    json?: boolean;
    yes?: boolean;
    maxTurns?: number;
    signal?: AbortSignal;
  } = {},
) {
  const p = tempProject({ 'src/math.ts': MATH });
  const model = fakeModel(script);
  let stdout = '';
  let stderr = '';
  const code = await runHeadless({
    task: 'fix add in src/math.ts',
    json: options.json ?? false,
    yes: options.yes ?? false,
    model: 'fake-main',
    stream: model,
    projectRoot: p.root,
    maxTurns: options.maxTurns ?? 10,
    out: (t) => {
      stdout += t;
    },
    err: (t) => {
      stderr += t;
    },
    environment: { ...ENV, projectRoot: p.root },
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  return { code, stdout, stderr, model, p };
}

const fixScript: ScriptedTurn[] = [
  {
    text: 'Reading it.',
    toolCalls: [{ id: 'r', name: 'read', args: { file_path: 'src/math.ts' } }],
  },
  {
    toolCalls: [
      {
        id: 'e',
        name: 'edit',
        args: {
          file_path: 'src/math.ts',
          old_string: 'a - b',
          new_string: 'a + b',
        },
      },
    ],
  },
  { text: 'Fixed add: it subtracted.' },
];

describe('runHeadless', () => {
  test('done → 0: text on stdout, one tool line per call on stderr', async () => {
    const { code, stdout, stderr, model, p } = await headless(fixScript, {
      yes: true,
    });
    expect(code).toBe(0);
    expect(stdout).toBe('Reading it.\nFixed add: it subtracted.\n');
    const lines = stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^▸ Read src\/math\.ts 3 lines \d+\.\d{2}s$/);
    expect(lines[1]).toMatch(
      /^▸ Edit src\/math\.ts replaced 1 occurrence \d+\.\d{2}s$/,
    );
    expect(p.read('src/math.ts')).toContain('return a + b;');
    expect(model.requests[0]?.model).toBe('fake-main');
  });

  test('sends the system prompt (environment last) and the task', async () => {
    const { model, p } = await headless([{ text: 'ok' }]);
    const [system, user] = model.requests[0]?.messages ?? [];
    expect(system?.role).toBe('system');
    const content = String(system?.content);
    expect(content.startsWith('You are Cookie')).toBe(true);
    expect(content).toContain('- read: ');
    expect(
      content.endsWith(
        `- Project root: ${p.root}\n- Git branch: main\n- Today's date: 2026-10-17\n`,
      ),
    ).toBe(true);
    expect(user).toEqual({ role: 'user', content: 'fix add in src/math.ts' });
  });

  test('--json prints only AgentEvents, one per line, ending with agent_end', async () => {
    const { code, stdout, stderr } = await headless(fixScript, {
      json: true,
      yes: true,
    });
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const events = stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    expect(events[0]).toEqual({ type: 'turn_start', turn: 1 });
    expect(events.at(-1)).toMatchObject({ type: 'agent_end', reason: 'done' });
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  test('max turns → 3', async () => {
    const { code, stderr } = await headless(
      [
        {
          toolCalls: [{ name: 'read', args: { file_path: 'src/math.ts' } }],
        },
      ],
      { maxTurns: 1 },
    );
    expect(code).toBe(3);
    expect(stderr).toContain('max_turns');
  });

  test('interrupted → 1, and the pending call is answered without running', async () => {
    const controller = new AbortController();
    const { code, stderr, p } = await headless(
      [
        {
          steps: [
            { type: 'tool_call_start', index: 0, id: 'w', name: 'write' },
            () => controller.abort(),
          ],
        },
      ],
      { yes: true, signal: controller.signal },
    );
    expect(code).toBe(1);
    expect(stderr).toContain('Interrupted by user');
    expect(existsSync(p.path('new.txt'))).toBe(false);
  });

  test('a provider error → 1, explained on stderr', async () => {
    const { code, stdout, stderr } = await headless([
      { fail: new ProviderError('upstream', { status: 503 }) },
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('cookie: ');
    expect(stderr).toContain('upstream provider failed');
    expect(stderr).toContain('because of an error');
  });
});

test('without an override, the environment is detected from the repo', async () => {
  const p = tempProject();
  const init = Bun.spawnSync(['git', 'init', '-q', '-b', 'gingersnap'], {
    cwd: p.root,
  });
  expect(init.exitCode).toBe(0);
  const model = fakeModel([{ text: 'ok' }]);
  const code = await runHeadless({
    task: 'hi',
    json: false,
    yes: false,
    model: 'fake-main',
    stream: model,
    projectRoot: p.root,
    maxTurns: 1,
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(0);
  const system = String(model.requests[0]?.messages[0]?.content);
  expect(system).toContain(`- Project root: ${p.root}\n`);
  expect(
    system.endsWith(
      `- Git branch: gingersnap\n- Today's date: ${localDate(new Date())}\n`,
    ),
  ).toBe(true);
});

describe('headless approvals', () => {
  const blockedScript: ScriptedTurn[] = [
    {
      toolCalls: [
        {
          id: 'w',
          name: 'write',
          args: { file_path: 'new.txt', content: 'hi\n' },
        },
        { id: 'b', name: 'bash', args: { command: 'touch marker' } },
        { id: 'r', name: 'read', args: { file_path: 'src/math.ts' } },
      ],
    },
    { text: 'I could not write.' },
  ];

  test('without --yes, writes and shell commands do not run', async () => {
    const { code, stderr, model, p } = await headless(blockedScript);
    expect(code).toBe(0);
    expect(existsSync(p.path('new.txt'))).toBe(false);
    expect(existsSync(p.path('marker'))).toBe(false);

    const toolMessages = (model.requests[1]?.messages ?? []).filter(
      (m) => m.role === 'tool',
    );
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['w', 'b', 'r']);
    for (const m of toolMessages.slice(0, 2)) {
      expect(String(m.content).startsWith(NEEDS_APPROVAL)).toBe(true);
      expect(String(m.content)).not.toMatch(/^error:/i);
    }
    // Reads still run.
    expect(String(toolMessages[2]?.content)).toContain('return a - b;');
    expect(stderr).toContain('✗ Write new.txt needs approval (--yes)');
    expect(stderr).toContain('✗ Bash touch marker needs approval (--yes)');
  });

  test('with --yes, they run', async () => {
    const { p } = await headless(blockedScript, { yes: true });
    expect(p.read('new.txt')).toBe('hi\n');
    expect(existsSync(p.path('marker'))).toBe(true);
  });

  test('edit is gated too', async () => {
    const { p } = await headless(fixScript);
    expect(p.read('src/math.ts')).toBe(MATH);
  });
});
