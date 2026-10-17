import { Box } from 'ink';
import { useMemo } from 'react';
import type { Item } from '../state.ts';
import { renderTranscript, viewport } from '../transcript.ts';
import { Lines } from './line-view.tsx';

export interface TranscriptProps {
  items: readonly Item[];
  width: number;
  height: number;
  /** Rows scrolled up from the bottom. */
  scroll?: number;
}

/** The newest rows that fit; the transcript is bottom-anchored like a chat. */
export function Transcript({
  items,
  width,
  height,
  scroll = 0,
}: TranscriptProps) {
  const rows = useMemo(() => renderTranscript(items, width), [items, width]);
  const visible = viewport(rows, height, scroll).rows;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      justifyContent="flex-end"
    >
      <Lines lines={visible} />
    </Box>
  );
}
