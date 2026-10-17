import { Box, Text } from 'ink';
import type { Line } from '../lines.ts';
import { useTheme } from '../theme.ts';

/** One pre-wrapped row. Rows are already fitted to the width, so Ink never re-wraps them. */
export function LineRow({ line }: { line: Line }) {
  const theme = useTheme();
  if (line.length === 0) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {line.map((seg, i) => {
        const color = seg.fg === undefined ? undefined : theme.color(seg.fg);
        const background =
          seg.bg === undefined ? undefined : theme.color(seg.bg);
        return (
          <Text
            // Segments never reorder within a row.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            key={i}
            {...(color !== undefined && { color })}
            {...(background !== undefined && { backgroundColor: background })}
            bold={seg.bold === true}
            italic={seg.italic === true}
            dimColor={seg.dim === true}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}

export function Lines({ lines }: { lines: readonly Line[] }) {
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <LineRow key={i} line={line} />
      ))}
    </Box>
  );
}
