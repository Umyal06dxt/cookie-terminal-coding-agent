import { describe, expect, test } from 'bun:test';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { REDACTED } from '../../src/storage/redact.ts';
import {
  fileTimestamp,
  listLogs,
  loadLog,
  SessionLog,
  sessionsDir,
  slugify,
} from '../../src/storage/sessionLog.ts';
import {
  NOT_FINISHED,
  recentSessions,
  restoreMessages,
} from '../../src/storage/sessions.ts';
import { cleanUpTempProjects, tempProject } from '../tools/helpers.ts';

cleanUpTempProjects();

const AT = new Date('2026-10-17T09:30:00Z');

function newLog(root: string, now = AT) {
  return new SessionLog({
    projectRoot: root,
    model: 'ds-flash',
    now: () => now,
  });
}

const conversation: ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are Cookie.' },
  { role: 'user', content: 'Fix the failing upload test!' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'read', arguments: '{"file_path":"a.ts"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'c1', content: '     1\tok' },
  { role: 'assistant', content: 'Fixed.' },
];

describe('SessionLog', () => {
  test('write/read round trip: meta, submit, events and messages in order', () => {
    const p = tempProject();
    const log = newLog(p.root);
    expect(log.path).toBeNull(); // Nothing is created until the first message.
    log.submit('Fix the failing upload test!');
    log.event({ type: 'turn_start', turn: 1 });
    log.messages(conversation.slice(0, 3));
    log.event({ type: 'usage', input: 100, output: 20, cacheRead: 0 });
    log.messages(conversation); // Only the two new ones are appended.
    log.event({
      type: 'agent_end',
      reason: 'done',
      turns: 2,
      summary: 'Finished in 2 turns.',
    });

    expect(log.path).toBe(
      join(
        sessionsDir(p.root),
        '2026-10-17T09-30-00-fix-the-failing-upload-test.jsonl',
      ),
    );
    const { records, skipped } = loadLog(log.path ?? '');
    expect(skipped).toBe(0);
    expect(records.map((r) => r.t)).toEqual([
      'meta',
      'submit',
      'event',
      'message',
      'message',
      'message',
      'event',
      'message',
      'message',
      'event',
    ]);
    expect(records[0]).toEqual({
      t: 'meta',
      version: 1,
      created: AT.toISOString(),
      model: 'ds-flash',
      projectRoot: p.root,
    });
    expect(restoreMessages(records)).toEqual(conversation);
  });

  test('each record is on disk as soon as it is written (one line per event)', () => {
    const p = tempProject();
    const log = newLog(p.root);
    log.submit('hi');
    log.event({ type: 'text_delta', text: 'a' });
    // Read without closing: nothing is buffered in the process.
    expect(
      readFileSync(log.path ?? '', 'utf8')
        .trimEnd()
        .split('\n'),
    ).toHaveLength(3);
  });

  test('a truncated last line (a crash mid-write) is skipped on load', () => {
    const p = tempProject();
    const log = newLog(p.root);
    log.submit('hi');
    log.event({ type: 'turn_start', turn: 1 });
    appendFileSync(
      log.path ?? '',
      '{"t":"event","at":"2026-10-17T09:30:00Z","event":{"type":"text_de',
    );
    const { records, skipped } = loadLog(log.path ?? '');
    expect(records.map((r) => r.t)).toEqual(['meta', 'submit', 'event']);
    expect(skipped).toBe(1);
  });

  test('lines that parse but are not records are skipped too', () => {
    const p = tempProject();
    const path = join(p.root, 'x.jsonl');
    writeFileSync(
      path,
      '{"t":"meta","version":1,"created":"x","model":"m","projectRoot":"/"}\n[1,2]\n"str"\n\n',
    );
    expect(loadLog(path)).toMatchObject({ skipped: 2 });
  });

  test('secrets are redacted before they reach the file', () => {
    const p = tempProject();
    const log = newLog(p.root);
    log.submit('my key is sk-proj-Abc123def456GHI789jkl012, use it');
    log.messages([
      {
        role: 'tool',
        tool_call_id: 'c',
        content: 'COMMANDCODE_API_KEY=user_9f8e7d6c5b4a39281706',
      },
    ]);
    const raw = readFileSync(log.path ?? '', 'utf8');
    expect(raw).not.toContain('sk-proj-Abc123');
    expect(raw).not.toContain('user_9f8e7d6c5b4a39281706');
    expect(raw).toContain(`COMMANDCODE_API_KEY=${REDACTED}`);
  });

  test('the sessions folder ignores itself, and same-second sessions get distinct names', () => {
    const p = tempProject();
    const a = newLog(p.root);
    const b = newLog(p.root);
    a.submit('same');
    b.submit('same');
    expect(readFileSync(join(sessionsDir(p.root), '.gitignore'), 'utf8')).toBe(
      '*\n',
    );
    expect(a.path).not.toBe(b.path);
    expect(b.path).toEndWith('-same-2.jsonl');
  });

  test('close starts a new file on the next message; reopen appends to an old one', () => {
    const p = tempProject();
    const log = newLog(p.root);
    log.submit('first');
    const first = log.path ?? '';
    log.close();
    log.submit('second');
    expect(log.path).not.toBe(first);

    const again = SessionLog.reopen(
      { projectRoot: p.root, model: 'ds-flash' },
      first,
      0,
    );
    again.submit('more');
    expect(loadLog(first).records.filter((r) => r.t === 'submit')).toHaveLength(
      2,
    );
    // A reopened log has no second meta line.
    expect(loadLog(first).records.filter((r) => r.t === 'meta')).toHaveLength(
      1,
    );
  });
});

describe('listing and restoring', () => {
  test('recentSessions: newest first, capped, with first message and cost', () => {
    const p = tempProject();
    for (let i = 0; i < 12; i++) {
      const log = newLog(p.root, new Date(AT.getTime() + i * 60_000));
      log.submit(`task   number\n${i}`);
      log.event({ type: 'usage', input: 1_000_000, output: 0, cacheRead: 0 });
      log.close();
    }
    const sessions = recentSessions(p.root, {
      'ds-flash': { input: 0.5, output: 1 },
    });
    expect(sessions).toHaveLength(10);
    expect(sessions[0]?.firstMessage).toBe('task number 11');
    expect(sessions[9]?.firstMessage).toBe('task number 2');
    expect(sessions[0]?.cost).toBe(0.5);
    expect(recentSessions(p.root, {}, 1)[0]?.cost).toBeNull();
  });

  test('no sessions folder means no sessions', () => {
    expect(listLogs(tempProject().root)).toEqual([]);
  });

  test('restoreMessages answers tool calls a crash left open, right after their turn', () => {
    const cut = conversation.slice(0, 3);
    const restored = restoreMessages(
      cut.map((message) => ({ t: 'message' as const, at: '', message })),
    );
    expect(restored.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: NOT_FINISHED,
    });
    expect(restored).toHaveLength(4);
  });

  test('file names: timestamp and slug', () => {
    expect(fileTimestamp(AT)).toBe('2026-10-17T09-30-00');
    expect(slugify('Fix the failing upload test!')).toBe(
      'fix-the-failing-upload-test',
    );
    expect(slugify('  ???  ')).toBe('session');
    expect(slugify('Añadir café ☕ ahora')).toBe('anadir-cafe-ahora');
    expect(slugify('x'.repeat(100))).toHaveLength(40);
  });
});
