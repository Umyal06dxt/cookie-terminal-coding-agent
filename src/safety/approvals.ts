/** What the approval card shows. Pure data; the UI renders it. */
export interface ApprovalRequest {
  tool: string;
  kind: 'write' | 'shell';
  args: unknown;
  /** The shell command, for shell tools. */
  command: string | null;
  destructive: boolean;
  /** Why it must be confirmed (destructive reasons), shown under the preview. */
  reasons: string[];
  /** False for destructive commands: they need a yes every time. */
  canAlways: boolean;
}

export type Answer =
  | { kind: 'yes' }
  | { kind: 'always' }
  | { kind: 'no'; reason?: string; interrupted?: boolean }
  | { kind: 'edit'; command: string };

/**
 * Connects the gate (which awaits an answer) to the UI (which shows one card at a time).
 * Requests queue in order; `cancelAll` answers every waiting one as interrupted.
 */
export class Approvals {
  private readonly queue: {
    request: ApprovalRequest;
    resolve: (a: Answer) => void;
  }[] = [];
  private listener: ((request: ApprovalRequest | null) => void) | null = null;

  /** The UI subscribes; it is told the current card (or null) whenever it changes. */
  subscribe(listener: (request: ApprovalRequest | null) => void): () => void {
    this.listener = listener;
    listener(this.current());
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  current(): ApprovalRequest | null {
    return this.queue[0]?.request ?? null;
  }

  ask = (request: ApprovalRequest): Promise<Answer> =>
    new Promise((resolve) => {
      this.queue.push({ request, resolve });
      if (this.queue.length === 1) this.listener?.(request);
    });

  /** Answers the card on screen and shows the next one, if any. */
  answer(answer: Answer): void {
    const head = this.queue.shift();
    if (!head) return;
    head.resolve(answer);
    this.listener?.(this.current());
  }

  cancelAll(): void {
    while (this.queue.length > 0)
      this.answer({ kind: 'no', interrupted: true });
  }
}
