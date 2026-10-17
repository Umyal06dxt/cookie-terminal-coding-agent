import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  headlessGate,
  interactiveGate,
  NEEDS_APPROVAL,
  type OvenMode,
  READ_ONLY,
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

describe('headlessGate', () => {
  test.each<ToolKind>(['read', 'plan'])(
    '%s tools run without --yes',
    (kind) => {
      expect(headlessGate(false)(toolOfKind(kind), {})).toBeNull();
    },
  );

  test.each<ToolKind>(['write', 'shell'])(
    '%s tools need approval without --yes',
    (kind) => {
      const denied = headlessGate(false)(toolOfKind(kind), {});
      expect(denied?.ok).toBe(false);
      expect(denied?.output).toBe(`${NEEDS_APPROVAL}.`);
      expect(denied?.hint).toContain('read-only');
      expect(denied?.summary).toBe('needs approval (--yes)');
    },
  );

  test.each<ToolKind>(['read', 'plan', 'write', 'shell'])(
    '--yes allows %s tools',
    (kind) => {
      expect(headlessGate(true)(toolOfKind(kind), {})).toBeNull();
    },
  );
});

describe('interactiveGate', () => {
  test('read-only blocks write and shell tools, allows reads', () => {
    const gate = interactiveGate(() => 'read-only');
    expect(gate(toolOfKind('read'), {})).toBeNull();
    expect(gate(toolOfKind('plan'), {})).toBeNull();
    for (const kind of ['write', 'shell'] as const) {
      const denied = gate(toolOfKind(kind), {});
      expect(denied?.ok).toBe(false);
      expect(denied?.output).toStartWith(READ_ONLY);
      expect(denied?.output).not.toMatch(/^Error:/);
      expect(denied?.summary).toBe('read-only (shift+tab)');
    }
  });

  test('the mode is read on every call, so a toggle applies at once', () => {
    let mode: OvenMode = 'read-only';
    const gate = interactiveGate(() => mode);
    expect(gate(toolOfKind('write'), {})).not.toBeNull();
    mode = 'full-oven';
    expect(gate(toolOfKind('write'), {})).toBeNull();
    expect(gate(toolOfKind('shell'), {})).toBeNull();
  });
});
