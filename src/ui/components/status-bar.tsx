import { Box } from 'ink';
import type { UiState } from '../state.ts';
import { statusLine } from '../status.ts';
import { useTheme } from '../theme.ts';
import { LineRow } from './line-view.tsx';

/** The top row plus a brown-butter rule under it. */
export function StatusBar({ state, width }: { state: UiState; width: number }) {
  const theme = useTheme();
  return (
    <Box flexDirection="column" width={width}>
      <LineRow line={statusLine(state, width, theme.glyph)} />
      <LineRow line={[{ text: '─'.repeat(width), fg: 'butter' }]} />
    </Box>
  );
}
