export type AgentEndReason =
  | 'done'
  | 'max_turns'
  | 'interrupted'
  | 'budget'
  | 'error';

/** Everything the UI and the session log need to follow a run. */
export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  /** `args` is the parsed object, or the raw string when the model sent invalid JSON. */
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      durationMs: number;
    }
  | { type: 'usage'; input: number; output: number; cacheRead: number }
  | { type: 'turn_end'; turn: number; finishReason: string | null }
  | { type: 'error'; message: string }
  | {
      type: 'agent_end';
      reason: AgentEndReason;
      turns: number;
      summary: string;
    };

export type EventSink = (event: AgentEvent) => void;
