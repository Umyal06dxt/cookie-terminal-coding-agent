import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { headlessGate, NEEDS_APPROVAL } from '../../src/safety/permissions.ts';
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
