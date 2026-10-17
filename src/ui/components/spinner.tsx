import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { FRAME_MS, spinnerText } from '../spinner.ts';
import { useTheme } from '../theme.ts';

/** "⠼ Kneading… 4s  esc to interrupt". Only mounted while a turn runs and nothing failed. */
export function Spinner({
  startedAt,
  now = Date.now,
}: {
  startedAt: number;
  now?: () => number;
}) {
  const theme = useTheme();
  const [elapsed, setElapsed] = useState(() => now() - startedAt);
  useEffect(() => {
    const timer = setInterval(() => setElapsed(now() - startedAt), FRAME_MS);
    return () => clearInterval(timer);
  }, [startedAt, now]);
  const { frame, verb, seconds } = spinnerText(elapsed);
  const crust = theme.color('crust');
  const chip = theme.color('chip');
  return (
    <Text>
      {'  '}
      <Text {...(crust !== undefined && { color: crust })}>
        {frame} {verb}…
      </Text>
      <Text {...(chip !== undefined && { color: chip })}>
        {' '}
        {seconds} · esc to interrupt
      </Text>
    </Text>
  );
}
