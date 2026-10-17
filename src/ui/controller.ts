import type { AgentEvent } from '../agent/events.ts';
import { runAgent } from '../agent/loop.ts';
import { Session } from '../agent/session.ts';
import type { ChatStream } from '../provider/stream.ts';
import type { AgentTool } from '../tools/types.ts';
import type { UiAction } from './state.ts';

/** What a conversation needs once the provider is ready. */
export interface Backend {
  model: string;
  stream: ChatStream;
  tools: readonly AgentTool[];
  systemPrompt: string;
  maxTurns: number;
  /** From the model catalog; null when it doesn't say. */
  contextWindow: number | null;
}

export type BackendResult =
  | { ok: true; backend: Backend }
  | { ok: false; message: string };

/**
 * Owns the conversation behind the UI: one Session across turns, one run at a time, and the
 * AbortController that esc and ctrl+c use. No Ink: tests drive it with fakeModel.
 */
export class ChatController {
  private session: Session | null = null;
  private running: AbortController | null = null;

  constructor(
    private readonly ready: Promise<BackendResult>,
    private readonly dispatch: (action: UiAction) => void,
  ) {}

  get busy(): boolean {
    return this.running !== null;
  }

  /** Sends a message and runs the agent until it ends. Ignored while a run is going. */
  async submit(text: string): Promise<void> {
    if (this.running) return;
    const controller = new AbortController();
    this.running = controller;
    this.dispatch({ type: 'submit', text });
    try {
      const result = await this.ready;
      if (!result.ok) {
        this.fail(result.message);
        return;
      }
      const { backend } = result;
      this.session ??= new Session([
        { role: 'system', content: backend.systemPrompt },
      ]);
      this.session.addUser(text);
      await runAgent({
        session: this.session,
        tools: backend.tools,
        model: backend.model,
        stream: backend.stream,
        maxTurns: backend.maxTurns,
        signal: controller.signal,
        onEvent: (event: AgentEvent) => this.dispatch({ type: 'agent', event }),
      });
    } catch (thrown) {
      // runAgent answers every failure with events; this is a bug, but keep the UI alive.
      this.fail(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      this.running = null;
    }
  }

  private fail(message: string): void {
    this.dispatch({ type: 'agent', event: { type: 'error', message } });
    this.dispatch({
      type: 'agent',
      event: { type: 'agent_end', reason: 'error', turns: 0, summary: message },
    });
  }

  /** Stops the running turn. Returns false when nothing was running. */
  interrupt(): boolean {
    if (!this.running || this.running.signal.aborted) return false;
    this.running.abort();
    return true;
  }

  /** Forgets the conversation (the system prompt is rebuilt on the next message). */
  clear(): void {
    this.interrupt();
    this.session = null;
    this.dispatch({ type: 'clear' });
  }
}
