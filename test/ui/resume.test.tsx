import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from 'ink-testing-library';
import { Approvals } from '../../src/safety/approvals.ts';
import { loadLog, SessionLog } from '../../src/storage/sessionLog.ts';
import {
  recentSessions,
  restoreMessages,
  type SessionSummary,
} from '../../src/storage/sessions.ts';
import { App } from '../../src/ui/app.tsx';
import { SessionPicker } from '../../src/ui/components/session-picker.tsx';
import { type Backend, ChatController } from '../../src/ui/controller.ts';
import { replayState } from '../../src/ui/restore.ts';
import type { UiAction } from '../../src/ui/state.ts';
import { fakeModel } from '../fake-model.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';
import { frameRows, STATUS } from './helpers.ts';

cleanUpTempProjects();
afterEach(cleanup);

function backend(turns: Parameters<typeof fakeModel>[0]): {
  model: ReturnType<typeof fakeModel>;
  ready: Promise<{ ok: true; backend: Backend }>;
} {
  const model = fakeModel(turns);
  return {
    model,
    ready: Promise.resolve({
      ok: true,
      backend: {
        model: 'fake',
        stream: model,
        tools: [],
        systemPrompt: 'You are Cookie.',
        maxTurns: 5,
        contextWindow: null,
      },
    }),
  };
}

/** Runs one logged conversation and returns its log path. */
async function loggedSession(
  root: string,
  turns: Parameters<typeof fakeModel>[0],
  text = 'add quotas',
) {
  const log = new SessionLog({ projectRoot: root, model: 'fake' });
  const { ready } = backend(turns);
  const controller = new ChatController(ready, () => {}, { log });
  await controller.submit(text);
  return log.path ?? '';
}

describe('controller + session log', () => {
  test('every message and event of a run lands in the log', async () => {
    const p = tempProject();
    const path = await loggedSession(p.root, [
      { text: 'Done: quotas added.', usage: { input: 50, output: 5 } },
    ]);
    const { records } = loadLog(path);
    expect(restoreMessages(records)).toEqual([
      { role: 'system', content: 'You are Cookie.' },
      { role: 'user', content: 'add quotas' },
      { role: 'assistant', content: 'Done: quotas added.' },
    ]);
    const events = records.flatMap((r) =>
      r.t === 'event' ? [r.event.type] : [],
    );
    expect(events).toContain('usage');
    expect(events.at(-1)).toBe('agent_end');
  });

  test('a log that cannot be written is reported once and the run carries on', async () => {
    const actions: UiAction[] = [];
    const broken = new SessionLog({
      projectRoot: '/dev/null/not-a-dir',
      model: 'fake',
    });
    const { ready } = backend([{ text: 'still works' }]);
    const controller = new ChatController(ready, (a) => actions.push(a), {
      log: broken,
    });
    await controller.submit('hi');
    const notices = actions.filter((a) => a.type === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      tone: 'error',
      text: expect.stringContaining("can't be resumed"),
    });
    expect(
      actions.some((a) => a.type === 'agent' && a.event.type === 'text_delta'),
    ).toBe(true);
  });

  test('resuming continues the same conversation and appends to the same file', async () => {
    const p = tempProject();
    const path = await loggedSession(p.root, [{ text: 'First answer.' }]);
    const [session] = recentSessions(p.root);
    if (!session) throw new Error('expected a session');
    const messages = restoreMessages(session.records);
    const { model, ready } = backend([{ text: 'Second answer.' }]);
    const log = SessionLog.reopen(
      { projectRoot: p.root, model: 'fake' },
      path,
      messages.length,
    );
    await new ChatController(ready, () => {}, { log, messages }).submit(
      'and then?',
    );
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    const all = restoreMessages(loadLog(path).records);
    expect(all.map((m) => m.content)).toEqual([
      'You are Cookie.',
      'add quotas',
      'First answer.',
      'and then?',
      'Second answer.',
    ]);
  });
});

describe('replayState', () => {
  test('rebuilds the transcript and ends idle with a "resumed" notice', async () => {
    const p = tempProject();
    const path = await loggedSession(p.root, [{ text: 'Quotas **done**.' }]);
    const state = replayState(loadLog(path).records, STATUS);
    expect(state.busy).toBe(false);
    expect(state.items.map((i) => i.kind)).toEqual([
      'user',
      'assistant',
      'notice',
    ]);
    expect(state.items.at(-1)).toMatchObject({
      tone: 'info',
      text: expect.stringContaining('Resumed the session from'),
    });
  });

  test('a run cut off by a crash is closed off: no spinner, no forever-running cards', () => {
    const state = replayState(
      [
        {
          t: 'meta',
          version: 1,
          created: '2026-10-17T09:30:00Z',
          model: 'm',
          projectRoot: '/p',
        },
        { t: 'submit', at: '', text: 'go' },
        { t: 'event', at: '', event: { type: 'turn_start', turn: 1 } },
        {
          t: 'event',
          at: '',
          event: {
            type: 'tool_call',
            id: 'c',
            name: 'bash',
            args: { command: 'bun test' },
          },
        },
      ],
      STATUS,
    );
    expect(state.busy).toBe(false);
    expect(state.items.find((i) => i.kind === 'tool')).toMatchObject({
      status: 'failed',
      summary: 'never finished',
    });
    expect(
      state.items.some(
        (i) => i.kind === 'notice' && i.text.includes('ended mid-run'),
      ),
    ).toBe(true);
  });
});

describe('resume UI', () => {
  const summary = (
    first: string,
    minutes: number,
    cost: number | null,
  ): SessionSummary => ({
    path: `/x/${first}.jsonl`,
    created: new Date(2026, 9, 17, 9, minutes),
    model: 'm',
    firstMessage: first,
    cost,
    records: [],
  });

  test('the picker lists time, cost and first message; enter opens the chosen one', async () => {
    const picked: string[] = [];
    const ui = render(
      <SessionPicker
        sessions={[
          summary('add upload quotas', 30, 0.38),
          summary('fix flaky test', 5, null),
        ]}
        width={80}
        onPick={(s) => {
          picked.push(s.firstMessage);
        }}
        onCancel={() => {}}
      />,
    );
    const rows = frameRows(ui.lastFrame());
    expect(rows).toContain(' › 2026-10-17 09:30   $0.38  add upload quotas');
    expect(rows).toContain('   2026-10-17 09:05          fix flaky test');
    ui.stdin.write('\x1b[B');
    await Bun.sleep(20);
    ui.stdin.write('\r');
    await Bun.sleep(20);
    expect(picked).toEqual(['fix flaky test']);
  });

  test('a resumed app shows the old transcript and sends the full history', async () => {
    const p = tempProject();
    const path = await loggedSession(p.root, [{ text: 'Quotas are in.' }]);
    const { records } = loadLog(path);
    const { model, ready } = backend([{ text: 'Tests added.' }]);
    const ui = render(
      <App
        status={STATUS}
        ready={ready}
        listFiles={async () => []}
        oven={{ get: () => 'bake', set: () => {} }}
        approvals={new Approvals()}
        version="0.1.0"
        size={{ columns: 80, rows: 24 }}
        resume={{
          state: replayState(records, STATUS),
          messages: restoreMessages(records),
        }}
      />,
    );
    await Bun.sleep(30);
    expect(frameRows(ui.lastFrame()).join('\n')).toContain('Quotas are in.');
    for (const ch of 'now tests') ui.stdin.write(ch);
    ui.stdin.write('\r');
    await Bun.sleep(120);
    expect(model.requests[0]?.messages.map((m) => m.content)).toEqual([
      'You are Cookie.',
      'add quotas',
      'Quotas are in.',
      'now tests',
    ]);
    expect(frameRows(ui.lastFrame()).join('\n')).toContain('Tests added.');
  });
});
