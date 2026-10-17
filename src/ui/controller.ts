import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AgentEvent } from '../agent/events.ts';
import { runAgent } from '../agent/loop.ts';
import { Session } from '../agent/session.ts';
import type { ChatStream } from '../provider/stream.ts';
import type { SessionLog } from '../storage/sessionLog.ts';
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

export interface ControllerOptions {
  /** Where every message and event is appended. Tests that don't care leave it out. */
  log?: SessionLog;
  /** A resumed conversation to continue, system prompt included. */
  messages?: ChatCompletionMessageParam[];
}

/**
 * Owns the conversation behind the UI: one Session across turns, one run at a time, the
 * AbortController that esc and ctrl+c use, and the session log. No Ink: tests drive it with
 * fakeModel.
 */
export class ChatController {
  private session: Session | null;
  private running: AbortController | null = null;
  private readonly log: SessionLog | undefined;
  private logFailed = false;

  constructor(
    private readonly ready: Promise<BackendResult>,
    private readonly dispatch: (action: UiAction) => void,
    options: ControllerOptions = {},
  ) {
    this.log = options.log;
    this.session = options.messages ? new Session(options.messages) : null;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Sends a message and runs the agent until it ends. Ignored while a run is going. */
  async submit(text: string): Promise<void> {
    if (this.running) return;
    const controller = new AbortController();
    this.running = controller;
    this.dispatch({ type: 'submit', text });
    this.record((log) => log.submit(text));
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
        onEvent: (event) => this.emit(event),
      });
    } catch (thrown) {
      // runAgent answers every failure with events; this is a bug, but keep the UI alive.
      this.fail(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      this.syncMessages();
      this.running = null;
    }
  }

  private emit(event: AgentEvent): void {
    this.dispatch({ type: 'agent', event });
    this.record((log) => log.event(event));
    // The loop adds messages around its events; catching up on each keeps the log current.
    this.syncMessages();
  }

  private syncMessages(): void {
    const session = this.session;
    if (session) this.record((log) => log.messages(session.messages));
  }

  /**
   * Logging never stops the conversation: a full disk or a deleted folder is reported once,
   * and the session carries on unlogged.
   */
  private record(write: (log: SessionLog) => void): void {
    if (!this.log || this.logFailed) return;
    try {
      write(this.log);
    } catch (error) {
      this.logFailed = true;
      const why = error instanceof Error ? error.message : String(error);
      this.dispatch({
        type: 'notice',
        tone: 'error',
        text: `Couldn't write the session log, so this session can't be resumed: ${why}`,
      });
    }
  }

  private fail(message: string): void {
    this.emit({ type: 'error', message });
    this.emit({
      type: 'agent_end',
      reason: 'error',
      turns: 0,
      summary: message,
    });
  }

  /** Stops the running turn. Returns false when nothing was running. */
  interrupt(): boolean {
    if (!this.running || this.running.signal.aborted) return false;
    this.running.abort();
    return true;
  }

  /** Forgets the conversation; the next message starts a new session and a new log file. */
  clear(): void {
    this.interrupt();
    this.session = null;
    this.record((log) => log.close());
    this.dispatch({ type: 'clear' });
  }
}
