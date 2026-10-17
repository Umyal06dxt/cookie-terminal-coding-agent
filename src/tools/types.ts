import type { z } from 'zod';

export type ToolKind = 'read' | 'write' | 'shell' | 'plan';

/** What Cookie remembers about a file the model has read, so edits can refuse stale views. */
export interface LedgerEntry {
  mtimeMs: number;
  size: number;
  /** True when the model has seen every line. */
  full: boolean;
}

/** Keyed by the file's real (symlink-resolved) absolute path. */
export type ReadLedger = Map<string, LedgerEntry>;

export interface ToolContext {
  /** Real, absolute path; tools never touch anything outside it. */
  projectRoot: string;
  signal: AbortSignal;
  readLedger: ReadLedger;
}

/**
 * A tool's answer. `output` never starts with "Error:"; when something went wrong it says what
 * happened, and `hint` says how to recover.
 */
export interface ToolResult {
  ok: boolean;
  output: string;
  hint?: string;
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  /** Plain objects only, no unions: some providers reject `anyOf` in tool parameters. */
  schema: S;
  kind: ToolKind;
  run(args: z.infer<S>, context: ToolContext): Promise<ToolResult>;
}

/** Keeps the schema's inferred argument type attached to `run`. */
export function defineTool<S extends z.ZodObject>(tool: Tool<S>): Tool<S> {
  return tool;
}

// --- The narrow interface the agent loop consumes (see ToolRegistry.forAgent). ---

/** What a tool hands the loop. `content` goes to the model; `summary` is the short UI line. */
export interface ToolOutput {
  ok: boolean;
  content: string;
  summary?: string;
}

export interface AgentToolContext {
  /** Fires when the user interrupts; long-running tools should stop promptly. */
  signal: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object, sent to the model as-is. */
  parameters: Record<string, unknown>;
  run(args: unknown, context: AgentToolContext): Promise<ToolOutput>;
}
