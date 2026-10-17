import { describe, expect, test } from 'bun:test';
import {
  createTheme,
  detectColorDepth,
  detectMode,
  hexTo256,
  PALETTE,
} from '../../src/ui/theme.ts';

describe('theme', () => {
  test('both variants define every token', () => {
    expect(Object.keys(PALETTE.light).sort()).toEqual(
      Object.keys(PALETTE.dark).sort(),
    );
    expect(PALETTE.dark.crust).toBe('#E0A458');
    expect(PALETTE.light.crust).toBe('#B8742C');
  });

  test('NO_COLOR turns every colour off', () => {
    const theme = createTheme({
      env: { NO_COLOR: '1', COLORTERM: 'truecolor' },
    });
    expect(theme.depth).toBe('none');
    expect(theme.color('crust')).toBeUndefined();
  });

  test('an empty NO_COLOR does not count', () => {
    expect(detectColorDepth({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe(
      'truecolor',
    );
  });

  test('truecolor terminals get hex, others the 256-colour fallback', () => {
    expect(
      createTheme({ env: { COLORTERM: '24bit' }, mode: 'dark' }).color('crust'),
    ).toBe('#E0A458');
    expect(
      createTheme({ env: { TERM: 'xterm-256color' }, mode: 'dark' }).color(
        'crust',
      ),
    ).toBe('ansi256(179)');
    expect(detectColorDepth({ TERM: 'dumb' })).toBe('none');
  });

  test('hexTo256 picks the cube or the grey ramp, whichever is closer', () => {
    expect(hexTo256('#000000')).toBe(16);
    expect(hexTo256('#FFFFFF')).toBe(231);
    expect(hexTo256('#FF0000')).toBe(196);
    expect(hexTo256('#808080')).toBe(244);
  });

  test('auto mode reads COLORFGBG; an explicit setting wins', () => {
    expect(detectMode({ COLORFGBG: '0;15' }, 'auto')).toBe('light');
    expect(detectMode({ COLORFGBG: '15;0' }, 'auto')).toBe('dark');
    expect(detectMode({}, 'auto')).toBe('dark');
    expect(detectMode({ COLORFGBG: '0;15' }, 'dark')).toBe('dark');
  });

  test('the glyph falls back to plain text without a Nerd Font', () => {
    expect(createTheme({ env: {} }).glyph).toBe('(•)');
    expect(createTheme({ env: {}, nerdFont: true }).glyph).toBe('\u{F0198}');
  });
});
