import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { z } from 'zod';
import { Approvals } from '../../src/safety/approvals.ts';
import {
  DEFAULT_ALLOW,
  interactiveGate,
  type OvenMode,
} from '../../src/safety/permissions.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { defineTool } from '../../src/tools/types.ts';
import { App } from '../../src/ui/app.tsx';
import type { BackendResult } from '../../src/ui/controller.ts';
import { fakeModel } from '../fake-model.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';
import { frameRows, STATUS } from './helpers.ts';

cleanUpTempProjects();
afterEach(cleanup);

const tick = (ms = 40) => Bun.sleep(ms);

/** The app wired like main.tsx, with a recording bash and a model that calls `call`. */
function bake(
  command: string,
  mode: OvenMode = 'bake',
  call: { name: string; args: Record<string, unknown> } = {
    name: 'bash',
    args: { command },
  },
) {
  const ran: string[] = [];
  const bash = defineTool({
    name: 'bash',
    kind: 'shell',
    description: 'run a command',
    schema: z.object({ command: z.string() }),
    run: async ({ command }) => {
      ran.push(command);
      return { ok: true, output: 'done', summary: 'exit 0' };
    },
  });
  const edit = defineTool({
    name: 'edit',
    kind: 'write',
    description: 'edit a file',
    schema: z.object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
    }),
    run: async ({ file_path }) => {
      ran.push(`edit ${file_path}`);
      return { ok: true, output: 'edited' };
    },
  });
  const project = tempProject();
  const approvals = new Approvals();
  const tools = new ToolRegistry().register(bash, edit).forAgent(
    { projectRoot: project.root, readLedger: project.ledger },
    {
      gate: interactiveGate({
        mode: () => mode,
        policy: {
          projectRoot: project.root,
          allow: [...DEFAULT_ALLOW],
          deny: [],
        },
        ask: approvals.ask,
      }),
    },
  );
  const model = fakeModel([
    { toolCalls: [{ id: 'c1', name: call.name, args: call.args }] },
    { text: 'Finished.' },
  ]);
  const ready: Promise<BackendResult> = Promise.resolve({
    ok: true,
    backend: {
      model: 'fake',
      stream: model,
      tools,
      systemPrompt: 'sys',
      maxTurns: 5,
      contextWindow: null,
    },
  });
  const ui = render(
    <App
      status={STATUS}
      ready={ready}
      listFiles={async () => []}
      oven={{ get: () => mode, set: () => {} }}
      approvals={approvals}
      version="0.1.0"
      size={{ columns: 80, rows: 24 }}
    />,
  );
  const screen = () => frameRows(ui.lastFrame()).join('\n');
  const send = async (keys: string[], ms = 40) => {
    for (const k of keys) {
      ui.stdin.write(k);
      await tick(10);
    }
    await tick(ms);
  };
  /** The tool message the model got back for the call. */
  const toolReply = () =>
    model.requests[1]?.messages.find((m) => m.role === 'tool')?.content;
  return { ui, ran, screen, send, toolReply };
}

async function start(b: ReturnType<typeof bake>) {
  await b.send([...'go', '\r'], 120);
}

describe('approval card in the app', () => {
  test('a destructive command shows a jam card; n with a reason goes to the model', async () => {
    const b = bake('git push origin main', 'full-oven');
    await start(b);
    const card = frameRows(b.ui.lastFrame());
    expect(card).toContain('  ⚠ Run this destructive command?');
    expect(card).toContain('    $ git push origin main');
    expect(card).toContain('    ! git push: changes a remote');
    expect(card).toContain('  y yes · n no · e edit');
    for (const row of card)
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
    // "a" is not offered and does nothing.
    await b.send(['a']);
    expect(b.screen()).toContain('Run this destructive command?');
    await b.send(['n']);
    expect(b.screen()).toContain('enter sends');
    await b.send([...'not today', '\r'], 120);
    expect(b.ran).toEqual([]);
    expect(b.toolReply()).toContain(
      'The user declined this. They said: "not today"',
    );
    expect(b.screen()).toContain('Finished.');
    expect(b.screen()).not.toContain('Run this destructive command?');
  });

  test('y runs the command once', async () => {
    const b = bake('bun run build');
    await start(b);
    expect(b.screen()).toContain(
      '  y yes · a always (this command) · n no · e edit',
    );
    await b.send(['y'], 120);
    expect(b.ran).toEqual(['bun run build']);
    expect(b.toolReply()).toBe('done');
  });

  test('e edits the command first, then runs the edited version', async () => {
    const b = bake('bun run build');
    await start(b);
    await b.send(['e']);
    expect(b.screen()).toContain('› bun run build');
    await b.send([...' --minify', '\r'], 120);
    expect(b.ran).toEqual(['bun run build --minify']);
  });

  test('esc on the card stops the run and nothing runs', async () => {
    const b = bake('bun run build');
    await start(b);
    await b.send(['\x1b'], 150);
    expect(b.ran).toEqual([]);
    expect(b.screen()).not.toContain('Run this command?');
    expect(b.screen()).toContain('Interrupted by user');
  });

  test('allow-listed commands in bake run without a card', async () => {
    const b = bake('git status');
    await start(b);
    expect(b.ran).toEqual(['git status']);
    expect(b.screen()).not.toContain('Run this command?');
  });

  test('a 30-line command still fits 80×24: the preview is cut, the keys stay', async () => {
    const script = Array.from({ length: 30 }, (_, i) => `echo step ${i}`).join(
      '\n',
    );
    const b = bake(script);
    await start(b);
    const rows = frameRows(b.ui.lastFrame());
    expect(rows).toHaveLength(24);
    expect(rows.join('\n')).toContain('more lines');
    expect(rows.join('\n')).toContain(
      'y yes · a always (this command) · n no · e edit',
    );
  });

  test('n on a 20-line edit in taste mode still fits 80×24', async () => {
    const lines = (p: string) =>
      Array.from({ length: 20 }, (_, i) => `${p} ${i}`).join('\n');
    const b = bake('', 'taste', {
      name: 'edit',
      args: {
        file_path: 'src/a.ts',
        old_string: lines('old'),
        new_string: lines('new'),
      },
    });
    await start(b);
    expect(b.screen()).toContain('Allow this edit to src/a.ts?');
    expect(frameRows(b.ui.lastFrame())).toHaveLength(24);
    await b.send(['n']);
    const rows = frameRows(b.ui.lastFrame());
    expect(rows).toHaveLength(24);
    expect(rows.join('\n')).toContain('Reason (optional)');
    await b.send([...'smaller please', '\r'], 120);
    expect(b.ran).toEqual([]);
    expect(b.toolReply()).toContain('They said: "smaller please"');
  });
});
