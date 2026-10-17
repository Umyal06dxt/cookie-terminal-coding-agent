import { Box, useInput } from 'ink';
import { useState } from 'react';
import type { SessionSummary } from '../../storage/sessions.ts';
import { sessionRows } from '../session-list.ts';
import { Lines } from './line-view.tsx';

export interface SessionPickerProps {
  sessions: readonly SessionSummary[];
  width: number;
  onPick: (session: SessionSummary) => void;
  onCancel: () => void;
}

/** `cookie --resume`: choose one of the last sessions with the arrows and enter. */
export function SessionPicker({
  sessions,
  width,
  onPick,
  onCancel,
}: SessionPickerProps) {
  const [selected, setSelected] = useState(0);
  useInput((input, key) => {
    if (key.eventType === 'release') return;
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow)
      setSelected((s) => (s - 1 + sessions.length) % sessions.length);
    if (key.downArrow) setSelected((s) => (s + 1) % sessions.length);
    const picked = sessions[selected];
    if (key.return && picked) onPick(picked);
  });
  return (
    <Box flexDirection="column" width={width} paddingTop={1}>
      <Lines lines={sessionRows(sessions, selected, width)} />
    </Box>
  );
}
