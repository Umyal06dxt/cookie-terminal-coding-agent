import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { runAgent } from '../../src/agent/loop.ts';
import { Session } from '../../src/agent/session.ts';
import { createDefaultRegistry } from '../../src/tools/index.ts';
import {
  findUnions,
  formatResult,
  ToolRegistry,
} from '../../src/tools/registry.ts';
import { defineTool, type ToolResult } from '../../src/tools/types.ts';
import { fakeModel } from '../fake-model.ts';
import { cleanUpTempProjects, tempProject } from './helpers.ts';

cleanUpTempProjects();

const echo = defineTool({
  name: 'echo',
  kind: 'plan',
  description: 'echo',
  schema: z.object({
    text: z.string(),
    times: z.number().int().min(1).optional(),
  }),
  run: async ({ text, times = 1 }) => ({
    ok: true,
    output: text.repeat(times),
  }),
});

const thrower = defineTool({
  name: 'thrower',
  kind: 'plan',
  description: 'always throws',
  schema: z.object({}),
  run: async () => {
    throw new Error('the oven door is stuck');
  },
});

const rude = defineTool({
  name: 'rude',
  kind: 'plan',
  description: 'returns an Error: prefix',
  schema: z.object({}),
  run: async () => ({ ok: false, output: 'Error: something broke' }),
});

describe('ToolRegistry', () => {
  test('the five default tools have provider-safe JSON schemas with no unions', () => {
    const registry = createDefaultRegistry();
    expect(registry.names()).toEqual(['read', 'glob', 'edit', 'write', 'bash']);
    for (const schema of registry.schemas()) {
      if (schema.type !== 'function')
        throw new Error('expected function tools');
      const params = schema.function.parameters ?? {};
      expect(findUnions(params)).toEqual([]);
      expect(params).toMatchObject({ type: 'object' });
      expect(JSON.stringify(params)).not.toContain('$schema');
      expect(JSON.stringify(params)).not.toContain('9007199254740991');
    }
  });

  test('optional fields are not required', () => {
    const params = createDefaultRegistry().parametersOf('read');
    expect(params?.required).toEqual(['file_path']);
  });

  test('refuses to register a tool whose schema has a union', () => {
    const bad = defineTool({
      name: 'bad',
      kind: 'plan',
      description: 'x',
      schema: z.object({ v: z.union([z.string(), z.number()]) }),
      run: async () => ({ ok: true, output: '' }),
    });
    expect(() => new ToolRegistry().register(bad)).toThrow(/union/);
    expect(
      findUnions({ properties: { a: { type: ['string', 'null'] } } }),
    ).toEqual(['$.properties.a.type']);
  });

  test('validates arguments and explains what is wrong', async () => {
    const registry = new ToolRegistry().register(echo);
    const ctx = tempProject().ctx();
    expect(await registry.run('echo', { text: 'hi', times: 2 }, ctx)).toEqual({
      ok: true,
      output: 'hihi',
    });
    const bad = await registry.run('echo', { text: 3, times: 0 }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain('text:');
    expect(bad.output).toContain('times:');
    expect(bad.hint).toContain('call echo again');
  });

  test('a stray extra key does not fail the call', async () => {
    const registry = new ToolRegistry().register(echo);
    expect(
      (
        await registry.run(
          'echo',
          { text: 'a', extra: true },
          tempProject().ctx(),
        )
      ).ok,
    ).toBe(true);
  });

  test('a throwing tool becomes ok:false with a recovery hint', async () => {
    const result = await new ToolRegistry()
      .register(thrower)
      .run('thrower', {}, tempProject().ctx());
    expect(result).toEqual({
      ok: false,
      output: 'The thrower tool failed unexpectedly: the oven door is stuck',
      hint: 'Check the arguments, or try a different approach.',
    });
  });

  test('results never start with "Error:"', async () => {
    const result = await new ToolRegistry()
      .register(rude)
      .run('rude', {}, tempProject().ctx());
    expect(result.output).toBe('something broke');
  });

  test("an async gate can wait, refuse, or run the user's edited arguments", async () => {
    const registry = new ToolRegistry().register(echo);
    const ctx = tempProject().ctx();
    const edited = await registry.run('echo', { text: 'a' }, ctx, async () => {
      await Bun.sleep(1);
      return { editedArgs: { text: 'b', times: 2 } };
    });
    expect(edited).toEqual({ ok: true, output: 'bb' });
    const bad = await registry.run('echo', { text: 'a' }, ctx, async () => ({
      editedArgs: { text: 7 },
    }));
    expect(bad.ok).toBe(false);
    expect(bad.output).toContain("The user's edited version");
    const refused = await registry.run(
      'echo',
      { text: 'a' },
      ctx,
      async () => ({
        ok: false,
        output: 'Error: declined',
      }),
    );
    expect(refused).toEqual({ ok: false, output: 'declined' });
  });

  test('unknown tool names list the real ones', async () => {
    const result = await new ToolRegistry()
      .register(echo)
      .run('nope', {}, tempProject().ctx());
    expect(result).toMatchObject({ ok: false, hint: 'Use one of: echo.' });
  });

  test('forAgent adapts tools for the loop, folding the hint into the content', async () => {
    const p = tempProject();
    const [agentTool] = new ToolRegistry()
      .register(thrower)
      .forAgent({ projectRoot: p.root, readLedger: p.ledger });
    const out = await agentTool?.run(
      {},
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      ok: false,
      content:
        'The thrower tool failed unexpectedly: the oven door is stuck\n\nHint: Check the arguments, or try a different approach.',
    });
    expect(formatResult({ ok: true, output: 'x' })).toBe('x');
  });
});

describe('ToolRegistry gate', () => {
  const ran: unknown[] = [];
  const counted = defineTool({
    name: 'counted',
    kind: 'write',
    description: 'records each run',
    schema: z.object({ n: z.number() }),
    run: async (args) => {
      ran.push(args);
      return { ok: true, output: 'ran', summary: 'did it' };
    },
  });
  const deny = (): ToolResult => ({
    ok: false,
    output: 'Error: not allowed here.',
    hint: 'Ask first.',
  });
  const signal = new AbortController().signal;

  test('a denying gate answers instead of the tool, which never runs', async () => {
    ran.length = 0;
    const p = tempProject();
    const seen: string[] = [];
    const result = await new ToolRegistry()
      .register(counted)
      .run('counted', { n: 1 }, p.ctx(), (tool, args) => {
        seen.push(`${tool.kind}:${JSON.stringify(args)}`);
        return deny();
      });
    expect(ran).toEqual([]);
    expect(seen).toEqual(['write:{"n":1}']);
    // The no-"Error:" rule holds for gate answers too.
    expect(result).toEqual({
      ok: false,
      output: 'not allowed here.',
      hint: 'Ask first.',
    });
  });

  test('arguments are validated before the gate is asked', async () => {
    let asked = false;
    const result = await new ToolRegistry()
      .register(counted)
      .run('counted', { n: 'one' }, tempProject().ctx(), () => {
        asked = true;
        return deny();
      });
    expect(asked).toBe(false);
    expect(result.output).toContain('The arguments for counted are invalid');
  });

  test('forAgent applies the gate and passes summaries through', async () => {
    ran.length = 0;
    const p = tempProject();
    const session = { projectRoot: p.root, readLedger: p.ledger };
    const [open] = new ToolRegistry().register(counted).forAgent(session);
    expect(await open?.run({ n: 2 }, { signal })).toEqual({
      ok: true,
      content: 'ran',
      summary: 'did it',
    });
    const [gated] = new ToolRegistry()
      .register(counted)
      .forAgent(session, { gate: deny });
    expect(await gated?.run({ n: 3 }, { signal })).toEqual({
      ok: false,
      content: 'not allowed here.\n\nHint: Ask first.',
    });
    expect(ran).toEqual([{ n: 2 }]);
  });
});

describe('registry + agent loop', () => {
  test('the loop runs a real tool through forAgent and sends its output back', async () => {
    const p = tempProject({ 'recipe.md': 'flour\nbutter\n' });
    const session = new Session([
      { role: 'user', content: 'what is in the recipe?' },
    ]);
    const model = fakeModel([
      {
        toolCalls: [
          { id: 'r', name: 'read', args: { file_path: 'recipe.md' } },
        ],
      },
      { text: 'Flour and butter.' },
    ]);
    const reason = await runAgent({
      session,
      tools: createDefaultRegistry().forAgent({
        projectRoot: p.root,
        readLedger: p.ledger,
      }),
      model: 'fake',
      stream: model,
    });
    expect(reason).toBe('done');
    expect(session.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'r',
      content: '     1\tflour\n     2\tbutter',
    });
    expect(model.requests[0]?.toolNames).toEqual([
      'read',
      'glob',
      'edit',
      'write',
      'bash',
    ]);
  });
});
