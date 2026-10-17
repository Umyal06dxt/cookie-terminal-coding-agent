import type { AgentEndReason, AgentEvent } from '../agent/events.ts';

export type Write = (text: string) => void;

export const EXIT = {
  done: 0,
  error: 1,
  usage: 2,
  maxTurns: 3,
} as const;

/** done → 0, max_turns → 3, everything else (error, budget, interrupted) → 1. */
export function exitCodeFor(reason: AgentEndReason): number {
  if (reason === 'done') return EXIT.done;
  if (reason === 'max_turns') return EXIT.maxTurns;
  return EXIT.error;
}

const TARGET_MAX = 60;

/** First line, at most `max` characters; "…" marks anything cut. */
function clip(text: string, max: number): string {
  const whole = text.trim();
  const line = whole.split('\n', 1)[0] ?? '';
  if (line.length > max) return `${line.slice(0, max - 1)}…`;
  return line.length < whole.length ? `${line}…` : line;
}

/** What a call acts on: its file, pattern or command. Empty when the args don't say. */
export function toolTarget(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const record = args as Record<string, unknown>;
  for (const key of ['file_path', 'pattern', 'command']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '')
      return clip(value, TARGET_MAX);
  }
  return '';
}

export interface ToolLine {
  name: string;
  args: unknown;
  ok: boolean;
  summary: string;
  durationMs: number;
}

/** "▸ Read src/math.ts 42 lines 0.02s"; a failed call starts with ✗ instead. */
export function formatToolLine(line: ToolLine): string {
  const name = line.name.charAt(0).toUpperCase() + line.name.slice(1);
  const parts = [
    line.ok ? '▸' : '✗',
    name,
    toolTarget(line.args),
    clip(line.summary, TARGET_MAX),
    `${(line.durationMs / 1000).toFixed(2)}s`,
  ];
  return parts.filter((p) => p !== '').join(' ');
}

/**
 * Plain-text mode: the model's words to stdout, one line per tool call to stderr, problems to
 * stderr. Keeps stdout ending on a newline before anything else is printed.
 */
export class TextPrinter {
  private readonly calls = new Map<string, { name: string; args: unknown }>();
  private midLine = false;

  constructor(
    private readonly out: Write,
    private readonly err: Write,
  ) {}

  private endLine(): void {
    if (this.midLine) this.out('\n');
    this.midLine = false;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        if (event.text === '') return;
        this.out(event.text);
        this.midLine = !event.text.endsWith('\n');
        return;
      case 'tool_call':
        this.calls.set(event.id, { name: event.name, args: event.args });
        return;
      case 'tool_result': {
        const call = this.calls.get(event.id);
        this.calls.delete(event.id);
        this.endLine();
        this.err(
          `${formatToolLine({
            name: event.name,
            args: call?.args,
            ok: event.ok,
            summary: event.summary,
            durationMs: event.durationMs,
          })}\n`,
        );
        return;
      }
      case 'turn_end':
        this.endLine();
        return;
      case 'error':
        this.endLine();
        this.err(`cookie: ${event.message}\n`);
        return;
      case 'agent_end':
        this.endLine();
        if (event.reason !== 'done') this.err(`cookie: ${event.summary}\n`);
        return;
      default:
        return;
    }
  }
}

/** --json mode: one AgentEvent per line on stdout, nothing else. */
export function jsonPrinter(out: Write): (event: AgentEvent) => void {
  return (event) => out(`${JSON.stringify(event)}\n`);
}
