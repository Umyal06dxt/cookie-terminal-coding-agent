/** What a tool hands back. `content` goes to the model; `summary` is the short line the UI shows. */
export interface ToolOutput {
  ok: boolean;
  content: string;
  summary?: string;
}

export interface ToolContext {
  /** Fires when the user interrupts; long-running tools should stop promptly. */
  signal: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object, sent to the model as-is. */
  parameters: Record<string, unknown>;
  run(args: unknown, context: ToolContext): Promise<ToolOutput>;
}
