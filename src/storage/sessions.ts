import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ModelPrice } from '../config/schema.ts';
import { type LogRecord, listLogs, loadLog } from './sessionLog.ts';

export interface SessionSummary {
  path: string;
  created: Date;
  model: string;
  /** The first thing the user typed, on one line. */
  firstMessage: string;
  /** USD, from the logged usage and today's [pricing]; null without a price. */
  cost: number | null;
  records: LogRecord[];
}

const perMillion = 1 / 1_000_000;

function costOf(
  records: readonly LogRecord[],
  price: ModelPrice | undefined,
): number | null {
  if (!price) return null;
  let usd = 0;
  for (const r of records) {
    if (r.t !== 'event' || r.event.type !== 'usage') continue;
    const { input, output, cacheRead } = r.event;
    const cached = Math.min(cacheRead, input);
    usd +=
      ((input - cached) * price.input +
        cached * (price.cache_read ?? price.input) +
        output * price.output) *
      perMillion;
  }
  return usd;
}

export function summarize(
  path: string,
  pricing: Readonly<Record<string, ModelPrice>>,
): SessionSummary | null {
  let records: LogRecord[];
  try {
    records = loadLog(path).records;
  } catch {
    return null; // Unreadable: leave it out of the list rather than fail the whole listing.
  }
  const meta = records.find((r) => r.t === 'meta');
  const first = records.find((r) => r.t === 'submit');
  if (meta?.t !== 'meta' || first?.t !== 'submit') return null;
  return {
    path,
    created: new Date(meta.created),
    model: meta.model,
    firstMessage: first.text.replace(/\s+/g, ' ').trim(),
    cost: costOf(records, pricing[meta.model]),
    records,
  };
}

/** The newest `limit` sessions that have at least one message. */
export function recentSessions(
  projectRoot: string,
  pricing: Readonly<Record<string, ModelPrice>> = {},
  limit = 10,
): SessionSummary[] {
  const found: SessionSummary[] = [];
  for (const path of listLogs(projectRoot)) {
    const summary = summarize(path, pricing);
    if (summary) found.push(summary);
    if (found.length === limit) break;
  }
  return found;
}

export const NOT_FINISHED =
  'Not run: the session ended before this tool call finished.';

/**
 * The conversation to continue from: every logged message, in order. A session cut off by a
 * crash can end with tool calls that never got answers, which the API rejects, so each gets
 * one now.
 */
export function restoreMessages(
  records: readonly LogRecord[],
): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  for (const r of records) if (r.t === 'message') messages.push(r.message);
  const answered = new Set(
    messages.flatMap((m) => (m.role === 'tool' ? [m.tool_call_id] : [])),
  );
  for (const m of [...messages]) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      if (answered.has(call.id)) continue;
      // Answers go right after the assistant turn that made the calls.
      const at = messages.indexOf(m) + 1;
      let insert = at;
      while (messages[insert]?.role === 'tool') insert++;
      messages.splice(insert, 0, {
        role: 'tool',
        tool_call_id: call.id,
        content: NOT_FINISHED,
      });
      answered.add(call.id);
    }
  }
  return messages;
}

/** "2026-10-17 11:36" in local time, for lists and notices. */
export function localTime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
