import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  argsJson: string;
}

/** The conversation in OpenAI chat format plus token totals. Pure data: no I/O. */
export class Session {
  readonly messages: ChatCompletionMessageParam[];
  readonly totals: TokenTotals = { input: 0, output: 0, cacheRead: 0 };

  constructor(messages: ChatCompletionMessageParam[] = []) {
    this.messages = [...messages];
  }

  addSystem(content: string): void {
    this.messages.push({ role: 'system', content });
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(text: string, toolCalls: readonly ToolCallRecord[] = []): void {
    const calls: ChatCompletionMessageToolCall[] = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argsJson },
    }));
    this.messages.push({
      role: 'assistant',
      content: text === '' ? null : text,
      ...(calls.length > 0 && { tool_calls: calls }),
    });
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: 'tool', tool_call_id: toolCallId, content });
  }

  addUsage(usage: TokenTotals): void {
    this.totals.input += usage.input;
    this.totals.output += usage.output;
    this.totals.cacheRead += usage.cacheRead;
  }

  /** Ids of tool calls that have no tool message yet. Empty whenever the history is valid. */
  unansweredToolCalls(): string[] {
    const answered = new Set<string>();
    const asked: string[] = [];
    for (const m of this.messages) {
      if (m.role === 'assistant') {
        for (const c of m.tool_calls ?? []) asked.push(c.id);
      } else if (m.role === 'tool') {
        answered.add(m.tool_call_id);
      }
    }
    return asked.filter((id) => !answered.has(id));
  }
}
