import type { AgentEvent } from '../agent/events.ts';
import { runAgent } from '../agent/loop.ts';
import {
  buildSystemPrompt,
  collectEnvironment,
  type PromptEnvironment,
} from '../agent/prompts/system.ts';
import { Session } from '../agent/session.ts';
import type { ChatStream } from '../provider/stream.ts';
import { headlessGate, policyFrom } from '../safety/permissions.ts';
import { createDefaultRegistry } from '../tools/index.ts';
import { realRoot } from '../tools/paths.ts';
import type { ReadLedger } from '../tools/types.ts';
import { exitCodeFor, jsonPrinter, TextPrinter, type Write } from './format.ts';

export interface HeadlessOptions {
  task: string;
  /** Print one AgentEvent per line instead of plain text. */
  json: boolean;
  /** Allow file changes and shell commands without asking. */
  yes: boolean;
  /** The main-role model id. */
  model: string;
  stream: ChatStream;
  projectRoot: string;
  maxTurns: number;
  /** cookie.toml [permissions]; destructive commands are refused either way. */
  permissions?: { allow: readonly string[]; deny: readonly string[] };
  out: Write;
  err: Write;
  signal?: AbortSignal;
  /** Overrides the detected environment, so tests get a fixed prompt. */
  environment?: PromptEnvironment;
}

/** Runs one task to completion without a UI. Returns the process exit code. */
export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const projectRoot = realRoot(options.projectRoot);
  const registry = createDefaultRegistry();
  const readLedger: ReadLedger = new Map();
  const tools = registry.forAgent(
    { projectRoot, readLedger },
    {
      gate: headlessGate(
        options.yes,
        policyFrom(
          { permissions: options.permissions ?? { allow: [], deny: [] } },
          projectRoot,
        ),
      ),
    },
  );
  const prompt = buildSystemPrompt(
    tools,
    options.environment ?? collectEnvironment(projectRoot),
  );
  const session = new Session([
    { role: 'system', content: prompt.text },
    { role: 'user', content: options.task },
  ]);

  let onEvent: (event: AgentEvent) => void;
  if (options.json) {
    onEvent = jsonPrinter(options.out);
  } else {
    const printer = new TextPrinter(options.out, options.err);
    onEvent = (event) => printer.handle(event);
  }

  const reason = await runAgent({
    session,
    tools,
    model: options.model,
    stream: options.stream,
    maxTurns: options.maxTurns,
    onEvent,
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  return exitCodeFor(reason);
}
