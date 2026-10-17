import { describe, expect, test } from 'bun:test';
import { createCtrlC, EXIT_WINDOW_MS, footerHints } from '../../src/ui/keys.ts';
import { spinnerText, VERB_MS, VERBS } from '../../src/ui/spinner.ts';

describe('ctrl+c twice', () => {
  test('the first press interrupts a run; a second within the window exits', () => {
    let t = 1000;
    const ctrlC = createCtrlC(() => t);
    expect(ctrlC.press({ busy: true, hasText: false })).toBe('interrupt');
    expect(ctrlC.armed()).toBe(true);
    t += EXIT_WINDOW_MS - 1;
    expect(ctrlC.press({ busy: false, hasText: false })).toBe('exit');
  });

  test('after the window it starts over', () => {
    let t = 0;
    const ctrlC = createCtrlC(() => t);
    expect(ctrlC.press({ busy: false, hasText: true })).toBe('clear');
    t += EXIT_WINDOW_MS + 1;
    expect(ctrlC.armed()).toBe(false);
    expect(ctrlC.press({ busy: false, hasText: false })).toBe('arm');
  });

  test('reset disarms (any other key)', () => {
    const ctrlC = createCtrlC(() => 0);
    ctrlC.press({ busy: false, hasText: false });
    ctrlC.reset();
    expect(ctrlC.press({ busy: false, hasText: false })).toBe('arm');
  });
});

describe('footer', () => {
  test('names the mode and the keys that work now', () => {
    expect(
      footerHints({ busy: false, armed: false, mode: 'Bake' }),
    ).toStartWith('Bake mode · ⇧⇥ oven · / commands');
    expect(footerHints({ busy: true, armed: false, mode: 'Full oven' })).toBe(
      'Full oven mode · ⇧⇥ oven · esc interrupt · ctrl+c ×2 exit',
    );
    expect(footerHints({ busy: true, armed: true, mode: 'Taste' })).toBe(
      'Press ctrl+c again to exit',
    );
    expect(
      Bun.stringWidth(
        footerHints({ busy: false, armed: false, mode: 'Full oven' }),
      ),
    ).toBeLessThan(80);
  });
});

describe('spinner', () => {
  test('rotates through the baking verbs', () => {
    expect(VERBS).toEqual([
      'Preheating',
      'Kneading',
      'Whisking',
      'Proofing',
      'Folding in',
      'Sprinkling',
      'Cooling on the rack',
    ]);
    const seen = VERBS.map((_, i) => spinnerText(i * VERB_MS).verb);
    expect(seen).toEqual([...VERBS]);
    expect(spinnerText(VERBS.length * VERB_MS).verb).toBe('Preheating');
  });

  test('frames advance and seconds count', () => {
    expect(spinnerText(0)).toEqual({
      frame: '⠋',
      verb: 'Preheating',
      seconds: '0s',
    });
    expect(spinnerText(4200).seconds).toBe('4s');
    expect(spinnerText(-5).frame).toBe('⠋');
  });
});
