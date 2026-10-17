import {
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentEvent } from '../agent/events.ts';
import { redactDeep } from './redact.ts';

/**
 * One line of a session log. `meta` comes first; then, in order, what the user typed, what the
 * agent did, and every message added to the conversation.
 */
export type LogRecord =
  | {
      t: 'meta';
      version: 1;
      created: string;
      model: string;
      projectRoot: string;
    }
  | { t: 'submit'; at: string; text: string }
  | { t: 'event'; at: string; event: AgentEvent }
  | { t: 'message'; at: string; message: ChatCompletionMessageParam };

export const SESSIONS_DIR = join('.cookie', 'sessions');

export function sessionsDir(projectRoot: string): string {
  return join(projectRoot, SESSIONS_DIR);
}

/** "2026-10-17T11-36-47": sortable, and legal in file names on every platform. */
export function fileTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replaceAll(':', '-');
}

/** "Fix the failing upload test!" → "fix-the-failing-upload-test". */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // "ñ" → "n", not "n-"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return slug === '' ? 'session' : slug;
}

/** The folder ignores itself, so logs never get committed without touching the project's .gitignore. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  try {
    writeFileSync(ignore, '*\n', { flag: 'wx' });
  } catch {
    // Already there.
  }
}

export interface SessionLogOptions {
  projectRoot: string;
  model: string;
  now?: () => Date;
}

/**
 * Append-only JSONL writer. Each record is redacted, then written with its own write() call,
 * so a crash loses at most the record being written; turn ends are also synced to disk. The
 * file is created on the first message, named after it.
 */
export class SessionLog {
  private fd: number | null = null;
  private filePath: string | null = null;
  private loggedMessages = 0;

  constructor(private readonly options: SessionLogOptions) {}

  /** Continues an existing log (cookie --resume / --continue). */
  static reopen(
    options: SessionLogOptions,
    path: string,
    messageCount: number,
  ): SessionLog {
    const log = new SessionLog(options);
    log.filePath = path;
    log.fd = openSync(path, 'a');
    log.loggedMessages = messageCount;
    return log;
  }

  get path(): string | null {
    return this.filePath;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private write(record: LogRecord): void {
    if (this.fd === null) return;
    writeSync(this.fd, `${JSON.stringify(redactDeep(record))}\n`);
  }

  private open(firstMessage: string): void {
    const created = this.now();
    const dir = sessionsDir(this.options.projectRoot);
    ensureDir(dir);
    const base = `${fileTimestamp(created)}-${slugify(firstMessage)}`;
    // Two sessions started in the same second get "-2", "-3"…
    for (let n = 1; this.fd === null; n++) {
      const path = join(dir, `${base}${n === 1 ? '' : `-${n}`}.jsonl`);
      try {
        this.fd = openSync(path, 'ax');
        this.filePath = path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99)
          throw error;
      }
    }
    this.write({
      t: 'meta',
      version: 1,
      created: created.toISOString(),
      model: this.options.model,
      projectRoot: this.options.projectRoot,
    });
  }

  submit(text: string): void {
    if (this.fd === null) this.open(text);
    this.write({ t: 'submit', at: this.now().toISOString(), text });
  }

  event(event: AgentEvent): void {
    this.write({ t: 'event', at: this.now().toISOString(), event });
    if (
      this.fd !== null &&
      (event.type === 'turn_end' || event.type === 'agent_end')
    ) {
      fdatasyncSync(this.fd);
    }
  }

  /** Appends the messages added since the last call. */
  messages(all: readonly ChatCompletionMessageParam[]): void {
    for (const message of all.slice(this.loggedMessages)) {
      this.write({ t: 'message', at: this.now().toISOString(), message });
    }
    this.loggedMessages = Math.max(this.loggedMessages, all.length);
  }

  /** /clear: the next message starts a new file. */
  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.filePath = null;
    this.loggedMessages = 0;
  }
}

export interface LoadedLog {
  records: LogRecord[];
  /** Lines that weren't valid records: a line cut off by a crash, or damage. */
  skipped: number;
}

function isRecord(value: unknown): value is LogRecord {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { t?: unknown }).t;
  return t === 'meta' || t === 'submit' || t === 'event' || t === 'message';
}

/** Reads a log, skipping any line that doesn't parse (a crash can cut the last one short). */
export function loadLog(path: string): LoadedLog {
  const records: LogRecord[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Session log paths, newest first. */
export function listLogs(projectRoot: string): string[] {
  let names: string[];
  try {
    names = readdirSync(sessionsDir(projectRoot));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((n) => join(sessionsDir(projectRoot), n));
}
