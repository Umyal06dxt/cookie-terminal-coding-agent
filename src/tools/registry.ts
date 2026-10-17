import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { realRoot } from './paths.ts';
import type { AgentTool, Tool, ToolContext, ToolResult } from './types.ts';

type JsonObject = Record<string, unknown>;

const UNION_KEYS = ['anyOf', 'oneOf', 'allOf', 'not'];

/** JSON-schema paths that use unions or multi-type `type` arrays. Empty means provider-safe. */
export function findUnions(schema: unknown, path = '$'): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((s, i) => findUnions(s, `${path}[${i}]`));
  if (typeof schema !== 'object' || schema === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (UNION_KEYS.includes(key) || (key === 'type' && Array.isArray(value))) {
      found.push(`${path}.${key}`);
    }
    found.push(...findUnions(value, `${path}.${key}`));
  }
  return found;
}

/** Drops noise zod emits that costs tokens on every request: `$schema` and ±2^53 bounds. */
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (typeof value !== 'object' || value === null) return value;
  const out: JsonObject = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === '$schema') continue;
    if (
      (key === 'maximum' || key === 'minimum') &&
      Math.abs(Number(v)) === Number.MAX_SAFE_INTEGER
    ) {
      continue;
    }
    out[key] = tidy(v);
  }
  return out;
}

export function toParameters(schema: z.ZodObject): JsonObject {
  return tidy(
    z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }),
  ) as JsonObject;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'arguments';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

/** Rule from CLAUDE.md: results never start with "Error:". */
function scrubPrefix(text: string): string {
  return text.replace(/^\s*error:\s*/i, '');
}

/** Output followed by the recovery hint: the single string the model sees. */
export function formatResult(result: ToolResult): string {
  return result.hint
    ? `${result.output}\n\nHint: ${result.hint}`
    : result.output;
}

/**
 * Decides whether a validated call may run. Returns null to allow it, or the result the model
 * sees instead (the tool does not run).
 */
export type ToolGate = (tool: Tool, args: unknown) => ToolResult | null;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly parameters = new Map<string, JsonObject>();

  register(...tools: Tool[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name))
        throw new Error(`Tool "${tool.name}" is registered twice`);
      const parameters = toParameters(tool.schema);
      const unions = findUnions(parameters);
      if (unions.length > 0) {
        throw new Error(
          `Tool "${tool.name}" uses union types (${unions.join(', ')}); some providers reject them`,
        );
      }
      this.tools.set(tool.name, tool);
      this.parameters.set(tool.name, parameters);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  parametersOf(name: string): JsonObject | undefined {
    return this.parameters.get(name);
  }

  /** Tool definitions in the OpenAI chat format. */
  schemas(): ChatCompletionTool[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.parameters.get(tool.name) ?? {},
      },
    }));
  }

  /** Validates, runs, and turns anything thrown into a result the model can act on. */
  async run(
    name: string,
    args: unknown,
    context: ToolContext,
    gate?: ToolGate,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: `There is no tool named "${name}".`,
        hint: `Use one of: ${this.names().join(', ')}.`,
      };
    }
    const parsed = tool.schema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        output: `The arguments for ${name} are invalid: ${describeIssues(parsed.error)}.`,
        hint: `Fix those fields and call ${name} again.`,
      };
    }
    const denied = gate?.(tool, parsed.data);
    if (denied) return { ...denied, output: scrubPrefix(denied.output) };
    let result: ToolResult;
    try {
      result = await tool.run(parsed.data, context);
    } catch (error) {
      if (context.signal.aborted) {
        return {
          ok: false,
          output: 'Interrupted by user while this was running.',
        };
      }
      const reason = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        output: `The ${name} tool failed unexpectedly: ${reason}`,
        hint: 'Check the arguments, or try a different approach.',
      };
    }
    return { ...result, output: scrubPrefix(result.output) };
  }

  /** Adapts every tool to the loop's interface, bound to this session's root and ledger. */
  forAgent(
    session: Omit<ToolContext, 'signal'>,
    options: { gate?: ToolGate } = {},
  ): AgentTool[] {
    // Paths are compared against the real root; a symlinked or 8.3-style root would make
    // every file look like it lives outside the project.
    const context = { ...session, projectRoot: realRoot(session.projectRoot) };
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: this.parameters.get(tool.name) ?? {},
      run: async (args, { signal }) => {
        const result = await this.run(
          tool.name,
          args,
          { ...context, signal },
          options.gate,
        );
        return {
          ok: result.ok,
          content: formatResult(result),
          ...(result.summary !== undefined && { summary: result.summary }),
        };
      },
    }));
  }
}
