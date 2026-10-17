/** docs/design.md, "Words". Chrome only: errors never use them. */
export const VERBS = [
  'Preheating',
  'Kneading',
  'Whisking',
  'Proofing',
  'Folding in',
  'Sprinkling',
  'Cooling on the rack',
] as const;

export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const FRAME_MS = 80;
export const VERB_MS = 3000;

/** The spinner row for a run that started `elapsedMs` ago: "⠼ Kneading… 4s". */
export function spinnerText(elapsedMs: number): {
  frame: string;
  verb: string;
  seconds: string;
} {
  const t = Math.max(0, elapsedMs);
  return {
    frame: FRAMES[Math.floor(t / FRAME_MS) % FRAMES.length] ?? '⠋',
    verb: VERBS[Math.floor(t / VERB_MS) % VERBS.length] ?? 'Preheating',
    seconds: `${Math.floor(t / 1000)}s`,
  };
}
