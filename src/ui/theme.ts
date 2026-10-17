import { createContext, useContext } from 'react';

/** The "Fresh Batch" palette from docs/design.md ("The vibe"). */
export type Token =
  | 'oven'
  | 'dough'
  | 'crust'
  | 'butter'
  | 'chip'
  | 'matcha'
  | 'jam'
  | 'blueberry'
  | 'sprinkle';

export type Mode = 'dark' | 'light';
export type ColorDepth = 'truecolor' | '256' | 'none';

export const PALETTE: Record<Mode, Record<Token, string>> = {
  dark: {
    oven: '#1C1410',
    dough: '#F5E6D3',
    crust: '#E0A458',
    butter: '#A0673A',
    chip: '#6B4A3A',
    matcha: '#9DC08B',
    jam: '#E26D6D',
    blueberry: '#8AA9D6',
    sprinkle: '#F2A7C3',
  },
  light: {
    oven: '#FBF4EA',
    dough: '#3B2418',
    crust: '#B8742C',
    butter: '#8A5530',
    chip: '#9C7B68',
    matcha: '#4F7A3E',
    jam: '#B53A3A',
    blueberry: '#3D63A0',
    sprinkle: '#C2557F',
  },
};

type Env = Record<string, string | undefined>;

/** NO_COLOR (any non-empty value) wins; then COLORTERM; then TERM. Unknown terminals get 256. */
export function detectColorDepth(env: Env): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.TERM === 'dumb') return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (env.WT_SESSION !== undefined) return 'truecolor';
  return '256';
}

/** `auto` reads COLORFGBG ("fg;bg"): a white or light-grey background means light. */
export function detectMode(env: Env, setting: Mode | 'auto'): Mode {
  if (setting !== 'auto') return setting;
  const bg = Number((env.COLORFGBG ?? '').split(';').at(-1));
  return bg === 7 || bg === 15 ? 'light' : 'dark';
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** The nearest xterm-256 colour: the 6×6×6 cube (16–231) or the grey ramp (232–255). */
export function hexTo256(hex: string): number {
  const [r, g, b] = rgb(hex);
  const distance = (c: [number, number, number]) =>
    (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
  const nearestStep = (v: number) =>
    CUBE.reduce(
      (best, step, i) =>
        Math.abs(step - v) < Math.abs((CUBE[best] ?? 0) - v) ? i : best,
      0,
    );
  const [ri, gi, bi] = [nearestStep(r), nearestStep(g), nearestStep(b)];
  const cube: [number, number, number] = [
    CUBE[ri] ?? 0,
    CUBE[gi] ?? 0,
    CUBE[bi] ?? 0,
  ];
  const greyIndex = Math.min(
    23,
    Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)),
  );
  const grey = 8 + greyIndex * 10;
  return distance([grey, grey, grey]) < distance(cube)
    ? 232 + greyIndex
    : 16 + 36 * ri + 6 * gi + bi;
}

export interface Theme {
  mode: Mode;
  depth: ColorDepth;
  /** A colour Ink understands (hex or `ansi256(n)`), or undefined when colour is off. */
  color(token: Token): string | undefined;
  /** The 1-character Chip for the status bar. */
  glyph: string;
}

export interface ThemeOptions {
  env?: Env;
  mode?: Mode | 'auto';
  nerdFont?: boolean;
}

/** Nerd Font "nf-md-cookie". */
const NERD_COOKIE = '\u{F0198}';

export function createTheme(options: ThemeOptions = {}): Theme {
  const env = options.env ?? process.env;
  const mode = detectMode(env, options.mode ?? 'auto');
  const depth = detectColorDepth(env);
  const palette = PALETTE[mode];
  return {
    mode,
    depth,
    color(token) {
      if (depth === 'none') return undefined;
      const hex = palette[token];
      return depth === 'truecolor' ? hex : `ansi256(${hexTo256(hex)})`;
    },
    glyph: options.nerdFont ? NERD_COOKIE : '(•)',
  };
}

/** Truecolor dark: the default for render tests. */
export const DEFAULT_THEME = createTheme({
  env: { COLORTERM: 'truecolor' },
  mode: 'dark',
});

export const ThemeContext = createContext<Theme>(DEFAULT_THEME);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
