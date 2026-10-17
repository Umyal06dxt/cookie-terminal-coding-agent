import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Answer,
  ApprovalRequest,
  Approvals,
} from '../safety/approvals.ts';
import type { CardPhase } from './approval-card.ts';
import { approvalIntent } from './approval-keys.ts';
import { type EditorState, editorReduce, emptyEditor } from './editor.ts';
import type { KeyInfo } from './keymap.ts';

/** What the app must still do after the card handled a key. */
export type ApprovalKeyResult = 'handled' | 'interrupt' | 'ctrl-c';

/**
 * The approval card's state: the request on screen, its phase, and the little editor used for
 * a "no" reason or an edited command. Answers go straight back to the waiting gate.
 */
export function useApproval(approvals: Approvals) {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [phase, setPhase] = useState<CardPhase>('choose');
  const [editor, setEditor] = useState<EditorState>(() => emptyEditor());
  // Keys can outrun renders; read the live values from refs (see App).
  const live = useRef({ request, phase, editor });

  // Stable: it only touches a ref and state setters.
  const update = useCallback((next: Partial<typeof live.current>) => {
    live.current = { ...live.current, ...next };
    if (next.request !== undefined) setRequest(next.request);
    if (next.phase !== undefined) setPhase(next.phase);
    if (next.editor !== undefined) setEditor(next.editor);
  }, []);

  useEffect(
    () =>
      approvals.subscribe((next) =>
        update({ request: next, phase: 'choose', editor: emptyEditor() }),
      ),
    [approvals, update],
  );

  const answer = (a: Answer) => approvals.answer(a);

  const handleKey = (input: string, key: KeyInfo): ApprovalKeyResult => {
    const { request: current, phase: at, editor: box } = live.current;
    if (!current) return 'handled';
    const intent = approvalIntent(input, key, at, current);
    switch (intent.type) {
      case 'ctrl-c':
        return 'ctrl-c';
      case 'interrupt':
        return 'interrupt';
      case 'yes':
        answer({ kind: 'yes' });
        return 'handled';
      case 'always':
        answer({ kind: 'always' });
        return 'handled';
      case 'ask-reason':
        update({ phase: 'reason', editor: emptyEditor() });
        return 'handled';
      case 'start-edit':
        update({
          phase: 'edit',
          editor: editorReduce(emptyEditor(), {
            type: 'set',
            text: current.command ?? '',
          }),
        });
        return 'handled';
      case 'back':
        update({ phase: 'choose' });
        return 'handled';
      case 'send': {
        const text = box.text.trim();
        if (at === 'edit') {
          if (text === '') return 'handled';
          answer({ kind: 'edit', command: text });
        } else {
          answer({ kind: 'no', ...(text !== '' && { reason: text }) });
        }
        return 'handled';
      }
      case 'edit':
        update({ editor: editorReduce(box, intent.action) });
        return 'handled';
      case 'none':
        return 'handled';
    }
  };

  return { request, phase, editor, handleKey };
}
