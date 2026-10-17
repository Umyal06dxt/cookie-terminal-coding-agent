import type { ApprovalRequest } from '../safety/approvals.ts';
import type { CardPhase } from './approval-card.ts';
import type { EditorAction } from './editor.ts';
import { editorKey, type KeyInfo } from './keymap.ts';

export type ApprovalIntent =
  | { type: 'yes' }
  | { type: 'always' }
  | { type: 'ask-reason' }
  | { type: 'start-edit' }
  /** Enter in the reason or edit box. */
  | { type: 'send' }
  /** Esc in the reason or edit box: back to y/a/n/e. */
  | { type: 'back' }
  /** Esc on the card: stop the run, like esc anywhere else. */
  | { type: 'interrupt' }
  | { type: 'ctrl-c' }
  | { type: 'edit'; action: EditorAction }
  | { type: 'none' };

/** What a key means while an approval card is up. Pure, like intentFor. */
export function approvalIntent(
  input: string,
  k: KeyInfo,
  phase: CardPhase,
  request: ApprovalRequest,
): ApprovalIntent {
  if (k.ctrl && input === 'c') return { type: 'ctrl-c' };
  if (phase !== 'choose') {
    if (k.escape) return { type: 'back' };
    if (k.return) return { type: 'send' };
    const action = editorKey(input, k);
    return action ? { type: 'edit', action } : { type: 'none' };
  }
  if (k.escape) return { type: 'interrupt' };
  if (k.ctrl || k.meta) return { type: 'none' };
  switch (input.toLowerCase()) {
    case 'y':
      return { type: 'yes' };
    case 'a':
      return request.canAlways ? { type: 'always' } : { type: 'none' };
    case 'n':
      return { type: 'ask-reason' };
    case 'e':
      return request.command !== null
        ? { type: 'start-edit' }
        : { type: 'none' };
    default:
      return { type: 'none' };
  }
}
