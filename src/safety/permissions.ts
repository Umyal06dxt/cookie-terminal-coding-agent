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

/** Interactive modes until approval cards exist: read-only, or "full oven" (no asks). */
export type OvenMode = 'read-only' | 'full-oven';

export const READ_ONLY = 'Not allowed: this session is read-only';

/**
 * The interactive UI has no approval card yet, so the user picks a mode up front (shift+tab
 * toggles it). `mode` is read on every call, so a toggle applies to the next tool call.
 */
export function interactiveGate(mode: () => OvenMode): ToolGate {
  return (tool) => {
    if (mode() === 'full-oven') return null;
    if (tool.kind !== 'write' && tool.kind !== 'shell') return null;
    return {
      ok: false,
      output: `${READ_ONLY}; the user can press shift+tab to allow file changes and shell commands.`,
      hint:
        'Carry on with read-only tools. Tell the user what you would change or run, and that ' +
        'shift+tab switches to full oven mode.',
      summary: 'read-only (shift+tab)',
    };
  };
}
