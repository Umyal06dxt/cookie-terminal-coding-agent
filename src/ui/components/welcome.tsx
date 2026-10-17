import { Box, Text } from 'ink';
import { halfBlocks, monochrome } from '../chip/sprite.ts';
import { useTheme } from '../theme.ts';

const TIPS = [
  'Ask for a change, or ask about the code.',
  '@ picks a file · / commands · shift+tab allows edits',
];

/** Chip and the lowercase wordmark, shown until the first message. */
export function Welcome({
  version,
  folder,
}: {
  version: string;
  folder: string;
}) {
  const theme = useTheme();
  const crust = theme.color('crust');
  const chip = theme.color('chip');
  const dough = theme.color('dough');
  const art =
    theme.depth === 'none'
      ? monochrome().map((row, y) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sprite rows are positional
          <Text key={y}>{row}</Text>
        ))
      : halfBlocks().map((cells, y) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: sprite rows are positional
          <Text key={y}>
            {cells.map((cell, x) => {
              const fg = cell.fg === undefined ? undefined : theme.hex(cell.fg);
              const bg = cell.bg === undefined ? undefined : theme.hex(cell.bg);
              return (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: sprite cells are positional
                  key={x}
                  {...(fg !== undefined && { color: fg })}
                  {...(bg !== undefined && { backgroundColor: bg })}
                >
                  {cell.char}
                </Text>
              );
            })}
          </Text>
        ));
  return (
    <Box flexDirection="row" paddingX={2} paddingY={1}>
      <Box flexDirection="column" width={16} flexShrink={0}>
        {art}
      </Box>
      <Box flexDirection="column" marginLeft={3} justifyContent="center">
        <Text bold {...(crust !== undefined && { color: crust })}>
          cookie
        </Text>
        <Text {...(chip !== undefined && { color: chip })}>
          v{version} · {folder}
        </Text>
        <Text> </Text>
        {TIPS.map((tip) => (
          <Text key={tip} {...(dough !== undefined && { color: dough })}>
            {tip}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
