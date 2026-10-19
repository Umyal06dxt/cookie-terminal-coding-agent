/**
 * Recording provider traffic for test/fixtures/recordings: every chat request and every streamed
 * chunk, with secrets removed. Used by scripts/record.ts and scripts/probe-quirks.ts; replayed
 * by test/replay-model.ts.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FetchLike } from '../../src/provider/client.ts';
import {
  type ProviderErrorKind,
  toProviderError,
} from '../../src/provider/errors.ts';
import { redact, redactDeep } from '../../src/storage/redact.ts';

export type RecordingRecord =
  | {
      t: 'meta';
      version: 1;
      model: string;
      task: string;
      yes: boolean;
      maxTurns: number;
      cookieVersion: string;
      repoHead: string | null;
      recordedAt: string;
    }
  /** Headers are names only: values (the API key above all) are never stored. */
  | {
      t: 'request';
      n: number;
      method: string;
      path: string;
      headers: string[];
      body: unknown;
    }
  | { t: 'response'; n: number; status: number; headers: string[] }
  /** One SSE `data:` payload, parsed. */
  | { t: 'chunk'; n: number; chunk: unknown }
  | { t: 'done'; n: number }
  /** A non-2xx body. */
  | { t: 'error'; n: number; body: unknown }
  /**
   * The request failed without an HTTP status (network, timeout, abort), or the stream broke
   * before [DONE]. `kind` is what toProviderError made of it, so replay raises the same thing.
   */
  | { t: 'failure'; n: number; kind: ProviderErrorKind; message: string }
  /** The response's text or tool arguments held a secret and were rewritten. */
  | { t: 'redacted'; n: number }
  /**
   * The last line: how the cookie run ended, and the end of what it printed on stderr. A run
   * that fails before its first request (no API key, bad config) has only meta and this.
   */
  | { t: 'exit'; code: number; stderr: string };

/**
 * Incremental SSE parser: feed it text as it arrives, in pieces of any size. Calls `onData`
 * with each event's `data:` payload (multi-line data joined with "\n").
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = '';
  const flushEvent = (block: string) => {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (lines.length === 0) return;
    onData(lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n'));
  };
  return {
    push(text: string) {
      buffer += text;
      // Events end at a blank line; keep a trailing "\r" until its "\n" arrives.
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? '';
      for (const part of parts) flushEvent(part);
    },
    end() {
      if (buffer.trim() !== '') flushEvent(buffer);
      buffer = '';
    },
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Redacts a whole response at once. Secrets stream in fragments ("sk-" in one chunk, the rest in
 * the next), so text and each tool call's arguments are assembled, redacted, and, only if that
 * changed anything, written back: the full redacted string in the first fragment, the rest
 * emptied. Then every remaining string is redacted too.
 */
export function redactChunks(chunks: readonly unknown[]): {
  chunks: unknown[];
  changed: boolean;
} {
  const copy = structuredClone(chunks) as unknown[];
  const deltas = copy.flatMap((c) =>
    list(obj(c)?.choices).flatMap((choice) => {
      const delta = obj(obj(choice)?.delta);
      return delta ? [delta] : [];
    }),
  );
  let changed = false;

  const rewrite = (
    fields: { get: () => string; set: (v: string) => void }[],
  ) => {
    const whole = fields.map((f) => f.get()).join('');
    const clean = redact(whole);
    if (clean === whole) return;
    changed = true;
    for (const [i, f] of fields.entries()) f.set(i === 0 ? clean : '');
  };

  rewrite(
    deltas
      .filter((d) => typeof d.content === 'string')
      .map((d) => ({
        get: () => d.content as string,
        set: (v: string) => {
          d.content = v;
        },
      })),
  );
  const byIndex = new Map<
    unknown,
    { get: () => string; set: (v: string) => void }[]
  >();
  for (const d of deltas) {
    for (const call of list(d.tool_calls)) {
      const fn = obj(obj(call)?.function);
      if (!fn || typeof fn.arguments !== 'string') continue;
      const key = obj(call)?.index;
      const fields = byIndex.get(key) ?? [];
      fields.push({
        get: () => fn.arguments as string,
        set: (v) => {
          fn.arguments = v;
        },
      });
      byIndex.set(key, fields);
    }
  }
  for (const fields of byIndex.values()) rewrite(fields);
  return { chunks: redactDeep(copy), changed };
}

function failureRecord(n: number, error: unknown): RecordingRecord {
  const message = error instanceof Error ? error.message : String(error);
  return {
    t: 'failure',
    n,
    kind: toProviderError(error).kind,
    message: redact(message),
  };
}

const isChat = (url: string) =>
  new URL(url).pathname.endsWith('/chat/completions');

/**
 * Wraps a fetch so every chat completion is recorded through `sink` while the caller reads the
 * stream as usual. A response is written once it ends (so it can be redacted whole); call
 * `settled()` before closing the file.
 */
export function createRecorder(sink: (record: RecordingRecord) => void) {
  let n = 0;
  const pending: Promise<void>[] = [];

  const recordStream = async (id: number, body: ReadableStream<Uint8Array>) => {
    const payloads: unknown[] = [];
    let done = false;
    let failure: unknown = null;
    const parser = createSseParser((data) => {
      if (data.trim() === '[DONE]') done = true;
      else payloads.push(JSON.parse(data));
    });
    const decoder = new TextDecoder();
    try {
      for await (const bytes of body)
        parser.push(decoder.decode(bytes, { stream: true }));
      parser.push(decoder.decode());
      parser.end();
    } catch (error) {
      failure = error;
    }
    const { chunks, changed } = redactChunks(payloads);
    for (const chunk of chunks) sink({ t: 'chunk', n: id, chunk });
    if (changed) sink({ t: 'redacted', n: id });
    if (done) sink({ t: 'done', n: id });
    if (failure !== null) sink(failureRecord(id, failure));
  };

  const fetch: (inner: FetchLike) => FetchLike =
    (inner) => async (input, init) => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(String(input), init);
      if (!isChat(request.url)) return inner(request);
      const id = ++n;
      const text = await request.clone().text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: keep the text (redacted below).
      }
      sink({
        t: 'request',
        n: id,
        method: request.method,
        path: new URL(request.url).pathname,
        headers: [...request.headers.keys()].sort(),
        body: redactDeep(body),
      });
      let response: Response;
      try {
        response = await inner(request);
      } catch (error) {
        sink(failureRecord(id, error));
        throw error;
      }
      sink({
        t: 'response',
        n: id,
        status: response.status,
        headers: [...response.headers.keys()].sort(),
      });
      if (!response.ok || !response.body) {
        const raw = await response.clone().text();
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Plain-text error body.
        }
        sink({ t: 'error', n: id, body: redactDeep(parsed) });
        return response;
      }
      const [forCaller, forRecord] = response.body.tee();
      pending.push(recordStream(id, forRecord));
      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

  return {
    fetch,
    /** Resolves once every response seen so far has been written. */
    settled: () => Promise.all(pending).then(() => undefined),
  };
}

/** Appends one JSON line per record, creating folders as needed. */
export function fileSink(path: string): (record: RecordingRecord) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (record) => appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** Reads a recording. Recordings are fixtures, so a bad line is an error, not something to skip. */
export function loadRecording(path: string): RecordingRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as RecordingRecord;
      } catch {
        throw new Error(
          `${path}:${i + 1} is not valid JSON; re-record this fixture`,
        );
      }
    });
}

/** "deepseek-v4.1-flash" stays; anything unsafe in a path becomes "-". */
export function safeName(text: string, max = 60): string {
  const name = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return name === '' ? 'task' : name;
}
