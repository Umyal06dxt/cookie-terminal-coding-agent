import type { ApprovalRequest } from '../../safety/approvals.ts';
import { approvalCard, type CardPhase } from '../approval-card.ts';
import type { EditorState } from '../editor.ts';
import { inputRows } from '../input-view.ts';
import { InputBox } from './input-box.tsx';
import { Lines } from './line-view.tsx';

export interface ApprovalPaneProps {
  request: ApprovalRequest;
  phase: CardPhase;
  editor: EditorState;
  width: number;
  /** Rows the whole pane may use, so the frame never outgrows the screen. */
  maxRows: number;
}

/** The reason or edit box under the card: none while choosing. */
function boxRows({ phase, editor, width }: ApprovalPaneProps): number {
  return phase === 'choose' ? 0 : inputRows(editor, width - 4, '').length + 2;
}

function cardLines(props: ApprovalPaneProps) {
  return approvalCard(
    props.request,
    props.width,
    props.phase,
    props.maxRows - boxRows(props),
  );
}

/** Rows the pane takes, so the transcript can give them up. */
export function approvalPaneHeight(props: ApprovalPaneProps): number {
  return cardLines(props).length + boxRows(props);
}

/** The approval card in place of the input box; a small box for the reason or edited command. */
export function ApprovalPane(props: ApprovalPaneProps) {
  const { phase, editor, width } = props;
  return (
    <>
      <Lines lines={cardLines(props)} />
      {phase !== 'choose' && (
        <InputBox
          editor={editor}
          picker={{ kind: 'none' }}
          selected={0}
          width={width}
          placeholder={phase === 'reason' ? 'Reason (optional)' : ''}
        />
      )}
    </>
  );
}
