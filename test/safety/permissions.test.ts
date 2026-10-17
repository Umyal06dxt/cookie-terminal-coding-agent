import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type Answer,
  type ApprovalRequest,
  Approvals,
} from '../../src/safety/approvals.ts';
import {
  headlessGate,
  interactiveGate,
  NEEDS_APPROVAL,
  type OvenMode,
  type Policy,
} from '../../src/safety/permissions.ts';
import { defineTool, type ToolKind } from '../../src/tools/types.ts';

const toolOfKind = (kind: ToolKind) =>
  defineTool({
    name: kind,
    kind,
    description: kind,
    schema: z.object({}),
    run: async () => ({ ok: true, output: 'ran' }),
  });

/** No allow or deny entries: only the built-in checks apply. */
const NO_LISTS: Policy = { projectRoot: '/p', home: '/h', allow: [], deny: [] };

describe('headlessGate', () => {
  test.each<ToolKind>(['read', 'plan'])(
    '%s tools run without --yes',
    (kind) => {
      expect(headlessGate(false, NO_LISTS)(toolOfKind(kind), {})).toBeNull();
    },
  );

  test.each<ToolKind>(['write', 'shell'])(
    '%s tools need approval without --yes',
    (kind) => {
      const denied = headlessGate(false, NO_LISTS)(toolOfKind(kind), {});
      expect(denied?.ok).toBe(false);
      expect(denied?.output).toBe(`${NEEDS_APPROVAL}.`);
      expect(denied?.hint).toContain('read-only');
      expect(denied?.summary).toBe('needs approval (--yes)');
    },
  );

  test.each<ToolKind>(['read', 'plan', 'write', 'shell'])(
    '--yes allows %s tools',
    (kind) => {
      expect(headlessGate(true, NO_LISTS)(toolOfKind(kind), {})).toBeNull();
    },
  );
});

describe('headlessGate with a policy', () => {
  const policy: Policy = {
    projectRoot: '/p',
    home: '/h',
    allow: [],
    deny: ['npm install*'],
  };
  const bash = defineTool({
    name: 'bash',
    kind: 'shell',
    description: 'bash',
    schema: z.object({ command: z.string() }),
    run: async () => ({ ok: true, output: 'ran' }),
  });

  test('destructive commands are refused even with --yes', () => {
    const result = headlessGate(true, policy)(bash, { command: 'git push' });
    expect(result?.ok).toBe(false);
    expect(result?.output).toContain('git push: changes a remote');
    expect(result?.summary).toBe('destructive, not run');
  });

  test('deny patterns refuse; everything else runs with --yes', () => {
    expect(
      headlessGate(true, policy)(bash, { command: 'npm install x' })?.summary,
    ).toBe('denied by [permissions]');
    expect(
      headlessGate(true, policy)(bash, { command: 'bun test' }),
    ).toBeNull();
  });
});

describe('interactiveGate', () => {
  const policy: Policy = {
    projectRoot: '/p',
    home: '/h',
    allow: ['bun test*'],
    deny: ['npm install*'],
  };
  const bash = defineTool({
    name: 'bash',
    kind: 'shell',
    description: 'bash',
    schema: z.object({
      command: z.string(),
      timeout_ms: z.number().optional(),
    }),
    run: async () => ({ ok: true, output: 'ran' }),
  });
  const write = toolOfKind('write');

  function setup(mode: OvenMode, answers: Answer[]) {
    const asked: ApprovalRequest[] = [];
    const gate = interactiveGate({
      mode: () => mode,
      policy,
      ask: async (request) => {
        asked.push(request);
        return answers.shift() ?? { kind: 'no' };
      },
    });
    return { gate, asked };
  }

  test('allowed calls run without asking', async () => {
    const { gate, asked } = setup('bake', []);
    expect(await gate(bash, { command: 'bun test' })).toBeNull();
    expect(await gate(write, {})).toBeNull();
    expect(asked).toEqual([]);
  });

  test('y runs once and asks again next time', async () => {
    const { gate, asked } = setup('bake', [{ kind: 'yes' }, { kind: 'yes' }]);
    expect(await gate(bash, { command: 'bun run build' })).toBeNull();
    expect(await gate(bash, { command: 'bun run build' })).toBeNull();
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      kind: 'shell',
      command: 'bun run build',
      destructive: false,
      canAlways: true,
    });
  });

  test('a (always) covers that exact command, or all edits, for the session', async () => {
    const { gate, asked } = setup('taste', [
      { kind: 'always' },
      { kind: 'always' },
    ]);
    await gate(bash, { command: 'bun run build' });
    expect(await gate(bash, { command: 'bun run build' })).toBeNull();
    await gate(write, { file_path: 'a.ts' });
    expect(await gate(write, { file_path: 'b.ts' })).toBeNull();
    expect(asked).toHaveLength(2);
    // A different command still asks.
    await gate(bash, { command: 'bun run dev' });
    expect(asked).toHaveLength(3);
  });

  test('destructive commands ask in full oven, never offer always, and always ask again', async () => {
    const { gate, asked } = setup('full-oven', [
      { kind: 'always' },
      { kind: 'yes' },
    ]);
    await gate(bash, { command: 'git push' });
    await gate(bash, { command: 'git push' });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({
      destructive: true,
      canAlways: false,
      reasons: ['git push: changes a remote'],
    });
  });

  test('n declines with the reason sent to the model', async () => {
    const { gate } = setup('bake', [
      { kind: 'no', reason: 'use bun, not npm' },
    ]);
    const result = await gate(bash, { command: 'npm run build' });
    expect(result).toMatchObject({
      ok: false,
      output: 'The user declined this. They said: "use bun, not npm"',
      summary: 'declined',
    });
  });

  test('e runs the edited command, keeping the other arguments', async () => {
    const { gate } = setup('bake', [
      { kind: 'edit', command: 'bun run build --minify' },
    ]);
    expect(
      await gate(bash, { command: 'bun run build', timeout_ms: 5000 }),
    ).toEqual({
      editedArgs: { command: 'bun run build --minify', timeout_ms: 5000 },
    });
  });

  test('an edited command is checked against the deny list again', async () => {
    const { gate } = setup('bake', [
      { kind: 'edit', command: 'npm install left-pad' },
    ]);
    const result = await gate(bash, { command: 'bun run build' });
    expect(result).toMatchObject({
      ok: false,
      summary: 'denied by [permissions]',
    });
  });

  test('deny patterns refuse without asking, in every mode', async () => {
    const { gate, asked } = setup('full-oven', []);
    const result = await gate(bash, { command: 'npm install left-pad' });
    expect(result).toMatchObject({
      ok: false,
      summary: 'denied by [permissions]',
    });
    expect((result as { output: string }).output).not.toMatch(/^Error:/);
    expect(asked).toEqual([]);
  });

  test('the mode is read on every call', async () => {
    let mode: OvenMode = 'taste';
    const asked: ApprovalRequest[] = [];
    const gate = interactiveGate({
      mode: () => mode,
      policy,
      ask: async (r) => {
        asked.push(r);
        return { kind: 'yes' };
      },
    });
    await gate(write, {});
    mode = 'bake';
    await gate(write, {});
    expect(asked).toHaveLength(1);
  });
});

describe('Approvals', () => {
  const request = (command: string): ApprovalRequest => ({
    tool: 'bash',
    kind: 'shell',
    args: { command },
    command,
    destructive: false,
    reasons: [],
    canAlways: true,
  });

  test('shows one card at a time, in order', async () => {
    const approvals = new Approvals();
    const shown: (string | null)[] = [];
    approvals.subscribe((r) => shown.push(r?.command ?? null));
    const first = approvals.ask(request('a'));
    const second = approvals.ask(request('b'));
    approvals.answer({ kind: 'yes' });
    approvals.answer({ kind: 'no' });
    expect(await first).toEqual({ kind: 'yes' });
    expect(await second).toEqual({ kind: 'no' });
    expect(shown).toEqual([null, 'a', 'b', null]);
  });

  test('cancelAll answers every waiting card as interrupted', async () => {
    const approvals = new Approvals();
    const waiting = [approvals.ask(request('a')), approvals.ask(request('b'))];
    approvals.cancelAll();
    expect(await Promise.all(waiting)).toEqual([
      { kind: 'no', interrupted: true },
      { kind: 'no', interrupted: true },
    ]);
    expect(approvals.current()).toBeNull();
  });
});
