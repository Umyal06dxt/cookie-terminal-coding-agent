import type { ToolGate } from '../tools/registry.ts';

export const NEEDS_APPROVAL = 'Needs approval; rerun with --yes';

/**
 * Headless mode has no one to ask, so file changes and shell commands run only when the user
 * passed --yes up front. Reads always run.
 */
export function headlessGate(yes: boolean): ToolGate {
  return (tool) => {
    if (yes || (tool.kind !== 'write' && tool.kind !== 'shell')) return null;
    return {
      ok: false,
      output: `${NEEDS_APPROVAL}.`,
      hint:
        'This headless run may only read: file changes and shell commands were not allowed. ' +
        'Carry on with read-only tools, and say in your summary what you could not do.',
      summary: 'needs approval (--yes)',
    };
  };
}
