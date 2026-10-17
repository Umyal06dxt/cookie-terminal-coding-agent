import { afterEach, describe, expect, test } from 'bun:test';
import { Box } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { ProviderError } from '../../src/provider/errors.ts';
import type { ChatStream } from '../../src/provider/stream.ts';
import type { OvenMode } from '../../src/safety/permissions.ts';
import { App } from '../../src/ui/app.tsx';
import { Welcome } from '../../src/ui/components/welcome.tsx';
import type { BackendResult } from '../../src/ui/controller.ts';
import { VERBS } from '../../src/ui/spinner.ts';
import { fakeModel, type ScriptedTurn } from '../fake-model.ts';
import { frameRows, STATUS } from './helpers.ts';

afterEach(cleanup);

const SIZE = { columns: 80, rows: 24 };

function app(turns: ScriptedTurn[], files: string[] = []) {
  const model = fakeModel(turns);
  let mode: OvenMode = 'read-only';
  const ready: Promise<BackendResult> = Promise.resolve({
    ok: true,
    backend: {
      model: 'fake',
      stream: model,
      tools: [],
      systemPrompt: 'sys',
      maxTurns: 5,
      contextWindow: 128_000,
    },
  });
  const ui = render(
    <App
      status={STATUS}
      ready={ready}
      listFiles={async () => files}
      oven={{
        get: () => mode,
        set: (m) => {
          mode = m;
        },
      }}
      version="0.1.0"
      size={SIZE}
    />,
  );
  return { ui, model, mode: () => mode };
}

/** Lets Ink process input and React flush. */
const tick = (ms = 30) => Bun.sleep(ms);

async function type(ui: ReturnType<typeof render>, text: string) {
  for (const ch of text) {
    ui.stdin.write(ch);
    await tick(5);
  }
}

describe('welcome screen', () => {
  test('Chip and the wordmark fit in 80 columns, each tip on one row', () => {
    const { lastFrame } = render(
      <Box width={80}>
        <Welcome version="0.1.0" folder="~/acme" />
      </Box>,
    );
    const rows = frameRows(lastFrame());
    expect(rows.join('\n')).toContain('cookie');
    expect(rows.join('\n')).toContain('v0.1.0 · ~/acme');
    expect(
      rows.some((r) => r.endsWith('Ask for a change, or ask about the code.')),
    ).toBe(true);
    expect(
      rows.some((r) =>
        r.endsWith('@ picks a file · / commands · shift+tab allows edits'),
      ),
    ).toBe(true);
    // 8 rows of half blocks between the padding rows.
    expect(rows.filter((r) => /[▀▄]/.test(r))).toHaveLength(8);
    for (const row of rows)
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
  });
});

describe('App at 80x24', () => {
  test('first frame: status bar, welcome, input box and footer, 24 rows', async () => {
    const { ui } = app([]);
    await tick();
    const rows = frameRows(ui.lastFrame());
    expect(rows).toHaveLength(24);
    expect(rows[0]).toContain('deepseek-v4.1-flash');
    expect(rows.join('\n')).toContain('cookie');
    expect(rows.join('\n')).toContain('Ask cookie anything');
    expect(rows.at(-1)).toContain('Read-only');
    for (const row of rows)
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
  });

  test('typing and enter send a message; the answer streams into the transcript', async () => {
    const { ui, model } = app([{ text: 'Use **bun test**.' }]);
    await type(ui, 'how do I test?');
    ui.stdin.write('\r');
    await tick(100);
    const screen = frameRows(ui.lastFrame()).join('\n');
    expect(screen).toContain('› how do I test?');
    expect(screen).toContain('Use bun test.');
    expect(model.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'how do I test?',
    });
  });

  test('fast typing then enter sends exactly what was typed', async () => {
    const { ui, model } = app([{ text: 'ok' }]);
    await tick();
    ui.stdin.write('h');
    ui.stdin.write('i');
    ui.stdin.write('\r');
    await tick(100);
    expect(model.requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'hi',
    });
  });

  test('"/" lists commands; /help prints the keys', async () => {
    const { ui } = app([]);
    await type(ui, '/');
    expect(frameRows(ui.lastFrame()).join('\n')).toContain('/clear');
    await type(ui, 'he');
    ui.stdin.write('\r');
    await tick();
    const rows = frameRows(ui.lastFrame());
    expect(rows.join('\n')).toContain('esc interrupts');
    // A multi-line notice still fits the screen.
    expect(rows).toHaveLength(24);
    for (const row of rows)
      expect(Bun.stringWidth(row)).toBeLessThanOrEqual(80);
  });

  test('"@" opens the file picker and tab inserts the path', async () => {
    const { ui } = app([], ['src/agent/loop.ts', 'README.md']);
    await type(ui, 'read @loo');
    await tick(50);
    expect(frameRows(ui.lastFrame()).join('\n')).toContain('src/agent/loop.ts');
    ui.stdin.write('\t');
    await tick();
    expect(frameRows(ui.lastFrame()).join('\n')).toContain(
      '› read @src/agent/loop.ts',
    );
  });

  test('shift+tab toggles the oven mode the gate reads', async () => {
    const { ui, mode } = app([]);
    ui.stdin.write('\x1b[Z');
    await tick();
    expect(mode()).toBe('full-oven');
    expect(frameRows(ui.lastFrame()).at(-1)).toContain('Full oven');
  });

  test('ctrl+c once arms; the footer says to press again', async () => {
    const { ui } = app([]);
    ui.stdin.write('\x03');
    await tick();
    expect(frameRows(ui.lastFrame()).at(-1)).toContain(
      'Press ctrl+c again to exit',
    );
  });
});

describe('App: interrupt and spinner', () => {
  /** A model that says one thing, then waits until it is aborted. */
  const hanging: ChatStream = async function* (params) {
    yield { type: 'text_delta', text: 'Working on it' };
    await new Promise<void>((resolve) => {
      if (params.signal?.aborted) resolve();
      params.signal?.addEventListener('abort', () => resolve());
    });
    yield { type: 'done', finishReason: null };
  };

  function hangingApp(stream: ChatStream) {
    const ready: Promise<BackendResult> = Promise.resolve({
      ok: true,
      backend: {
        model: 'fake',
        stream,
        tools: [],
        systemPrompt: 'sys',
        maxTurns: 5,
        contextWindow: null,
      },
    });
    return render(
      <App
        status={STATUS}
        ready={ready}
        listFiles={async () => []}
        oven={{ get: () => 'read-only', set: () => {} }}
        version="0.1.0"
        size={SIZE}
        now={() => 0}
      />,
    );
  }

  test('the spinner shows a baking verb while a turn runs, and esc stops it', async () => {
    const ui = hangingApp(hanging);
    await type(ui, 'go');
    ui.stdin.write('\r');
    await tick(60);
    let screen = frameRows(ui.lastFrame()).join('\n');
    expect(screen).toContain('Preheating…');
    expect(screen).toContain('Working on it');
    ui.stdin.write('\x1b');
    await tick(150);
    screen = frameRows(ui.lastFrame()).join('\n');
    expect(screen).toContain('Interrupted by user');
    expect(screen).not.toContain('Preheating');
  });

  test('errors never get a spinner verb', async () => {
    const failure = new ProviderError('upstream');
    const failing = fakeModel([{ fail: failure }]);
    const ui = hangingApp(failing);
    await type(ui, 'go');
    ui.stdin.write('\r');
    await tick(100);
    const screen = frameRows(ui.lastFrame()).join('\n');
    expect(screen).toContain(failure.explanation.slice(0, 30));
    for (const verb of VERBS) expect(screen).not.toContain(verb);
  });
});
