/** How long a first Ctrl+C stays armed. */
export const EXIT_WINDOW_MS = 2000;

export type CtrlCOutcome =
  /** First press during a run: stop the turn and arm. */
  | 'interrupt'
  /** First press with text typed: clear it and arm. */
  | 'clear'
  /** First press otherwise: just arm and say "press again to exit". */
  | 'arm'
  | 'exit';

/**
 * Ctrl+C twice exits. Raw mode means no SIGINT reaches the process, so the UI calls this on
 * every Ctrl+C keypress. `now` is injected so tests control the clock.
 */
export function createCtrlC(now: () => number = Date.now) {
  let armedAt: number | null = null;
  return {
    press(context: { busy: boolean; hasText: boolean }): CtrlCOutcome {
      const t = now();
      if (armedAt !== null && t - armedAt <= EXIT_WINDOW_MS) return 'exit';
      armedAt = t;
      if (context.busy) return 'interrupt';
      if (context.hasText) return 'clear';
      return 'arm';
    },
    /** Whether "press ctrl+c again to exit" should still show. */
    armed(): boolean {
      return armedAt !== null && now() - armedAt <= EXIT_WINDOW_MS;
    },
    reset(): void {
      armedAt = null;
    },
  };
}

export type CtrlC = ReturnType<typeof createCtrlC>;

/** The footer: the oven mode and the keys that do something right now. */
export function footerHints(state: {
  busy: boolean;
  armed: boolean;
  /** "Taste", "Bake" or "Full oven". */
  mode: string;
}): string {
  if (state.armed) return 'Press ctrl+c again to exit';
  const keys = state.busy
    ? ['esc interrupt', 'ctrl+c ×2 exit']
    : ['/ commands', '@ files', '\\⏎ newline', 'ctrl+c ×2 exit'];
  return [`${state.mode} mode`, '⇧⇥ oven', ...keys].join(' · ');
}
