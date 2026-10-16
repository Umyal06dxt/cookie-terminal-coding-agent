import type { AgentTool, ToolOutput } from '../tools/types.ts';
import type { EventSink } from './events.ts';
import type { Session, ToolCallRecord } from './session.ts';

export const INTERRUPTED_BEFORE = 'Interrupted by user before this ran.';
export const INTERRUPTED_DURING = 'Interrupted by user while this was running.';
export const LOOP_STOPPED =
  'Not run: this exact call (same tool, same arguments) was already made twice in a row. ' +
  'The agent stopped so you can try a different approach.';
const SKIPPED_AFTER_LOOP =
  'Not run: the agent stopped after detecting a repeated call.';

export const LOOP_LIMIT = 3;

type ParsedArgs = { ok: true; value: unknown } | { ok: false; reason: string };

function parseArgs(argsJson: string): ParsedArgs {
  const text = argsJson.trim() === '' ? '{}' : argsJson;
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` count as the same arguments. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Spots the same tool + identical arguments `limit` times in a row, across turns. */
export class LoopDetector {
  private last = '';
  private streak = 0;

  constructor(private readonly limit: number = LOOP_LIMIT) {}

  /** Records a call; true when this call completes a run of `limit` identical ones. */
  record(name: string, argsJson: string): boolean {
    const parsed = parseArgs(argsJson);
    const signature = `${name}\u0000${parsed.ok ? canonical(parsed.value) : argsJson.trim()}`;
    this.streak = signature === this.last ? this.streak + 1 : 1;
    this.last = signature;
    return this.streak >= this.limit;
  }
}

function firstLine(text: string, max = 100): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function execute(
  tool: AgentTool | undefined,
  call: ToolCallRecord,
  args: ParsedArgs,
  available: readonly string[],
  signal: AbortSignal,
): Promise<ToolOutput> {
  if (!tool) {
    return {
      ok: false,
      content: `There is no tool named "${call.name}". Available tools: ${available.join(', ') || 'none'}. Call one of those instead.`,
    };
  }
  if (!args.ok) {
    return {
      ok: false,
      content: `The arguments for ${call.name} were not valid JSON (${args.reason}). Send the call again with a single JSON object.`,
    };
  }
  try {
    return await tool.run(args.value, { signal });
  } catch (error) {
    if (signal.aborted) return { ok: false, content: INTERRUPTED_DURING };
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      content: `The ${call.name} tool crashed: ${reason}. Check the arguments, or try a different approach.`,
    };
  }
}

/** Answers calls that will never run, with the same events a run would emit. */
export function answerUnrun(
  calls: readonly ToolCallRecord[],
  content: string,
  session: Session,
  emit: EventSink,
): void {
  for (const call of calls) {
    const args = parseArgs(call.argsJson);
    emit({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      args: args.ok ? args.value : call.argsJson,
    });
    session.addToolResult(call.id, content);
    emit({
      type: 'tool_result',
      id: call.id,
      name: call.name,
      ok: false,
      summary: firstLine(content),
      durationMs: 0,
    });
  }
}

export interface RunToolsContext {
  tools: readonly AgentTool[];
  session: Session;
  signal: AbortSignal;
  emit: EventSink;
  loops: LoopDetector;
  now?: () => number;
}

export type ToolsOutcome = 'ok' | 'interrupted' | 'loop';

/**
 * Runs one turn's tool calls in order (sequential for now) and appends exactly one tool
 * message per call, whatever happens: success, crash, unknown tool, interrupt or loop stop.
 */
export async function runToolCalls(
  calls: readonly ToolCallRecord[],
  context: RunToolsContext,
): Promise<ToolsOutcome> {
  const { tools, session, signal, emit, loops } = context;
  const now = context.now ?? (() => performance.now());
  const byName = new Map(tools.map((t) => [t.name, t]));
  let outcome: ToolsOutcome = 'ok';

  for (const call of calls) {
    const args = parseArgs(call.argsJson);
    emit({
      type: 'tool_call',
      id: call.id,
      name: call.name,
      args: args.ok ? args.value : call.argsJson,
    });

    let output: ToolOutput;
    let durationMs = 0;
    if (outcome === 'interrupted' || (outcome === 'ok' && signal.aborted)) {
      outcome = 'interrupted';
      output = { ok: false, content: INTERRUPTED_BEFORE };
    } else if (outcome === 'loop') {
      output = { ok: false, content: SKIPPED_AFTER_LOOP };
    } else if (loops.record(call.name, call.argsJson)) {
      outcome = 'loop';
      output = { ok: false, content: LOOP_STOPPED };
    } else {
      const started = now();
      output = await execute(
        byName.get(call.name),
        call,
        args,
        [...byName.keys()],
        signal,
      );
      durationMs = Math.max(0, now() - started);
      if (signal.aborted) outcome = 'interrupted';
    }

    session.addToolResult(call.id, output.content);
    emit({
      type: 'tool_result',
      id: call.id,
      name: call.name,
      ok: output.ok,
      summary: output.summary ?? firstLine(output.content),
      durationMs,
    });
  }
  return outcome;
}
