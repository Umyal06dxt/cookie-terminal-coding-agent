import type { ToolGate } from '../tools/registry.ts';
import type { Tool, ToolResult } from '../tools/types.ts';
import type { Answer, ApprovalRequest } from './approvals.ts';
import { destructiveReasons } from './destructive.ts';
import { commandTexts, parseShell } from './shell-parse.ts';

/** docs/design.md, "Safety and permissions". */
export type OvenMode = 'taste' | 'bake' | 'full-oven';
const OVEN_MODES: readonly OvenMode[] = ['taste', 'bake', 'full-oven'];
export const MODE_LABELS: Record<OvenMode, string> = {
  taste: 'Taste',
  bake: 'Bake',
  'full-oven': 'Full oven',
};

export function nextMode(mode: OvenMode): OvenMode {
  return (
    OVEN_MODES[(OVEN_MODES.indexOf(mode) + 1) % OVEN_MODES.length] ?? 'bake'
  );
}

/** Allow-listed in bake mode out of the box: they only look. */
export const DEFAULT_ALLOW: readonly string[] = [
  'git status*',
  'git diff*',
  'git log*',
  'git show*',
  'ls',
  'ls *',
  'pwd',
];

export interface Policy {
  projectRoot: string;
  /** Command patterns from [permissions] allow, plus DEFAULT_ALLOW. "*" matches anything. */
  allow: readonly string[];
  /** Command patterns from [permissions] deny: refused in every mode. */
  deny: readonly string[];
  home?: string;
}

/** The policy for a project: cookie.toml [permissions] on top of DEFAULT_ALLOW. */
export function policyFrom(
  config: {
    permissions: { allow: readonly string[]; deny: readonly string[] };
  },
  projectRoot: string,
): Policy {
  return {
    projectRoot,
    allow: [...DEFAULT_ALLOW, ...config.permissions.allow],
    deny: config.permissions.deny,
  };
}

export type Verdict = 'allow' | 'ask' | 'deny';

export interface Decision {
  verdict: Verdict;
  /** Set for shell commands that always ask (or the deny pattern that matched). */
  reasons: string[];
  destructive: boolean;
}

/** A glob over the whole command text: "*" is any run of characters, nothing else is special. */
export function matchesPattern(pattern: string, command: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  const source = norm(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(norm(command));
}

/** The command a shell tool call runs, or null for other tools. */
export function shellCommand(
  tool: Pick<Tool, 'kind'>,
  args: unknown,
): string | null {
  if (tool.kind !== 'shell' || typeof args !== 'object' || args === null)
    return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

/**
 * What to do with a shell command. Deny patterns win, matched against the whole command and
 * each part of a chain; destructive commands always ask; then the mode decides. In bake mode a
 * chain runs unasked only when every part is allow-listed and nothing is hidden in $(…).
 */
export function decideShell(
  command: string,
  mode: OvenMode,
  policy: Policy,
): Decision {
  const parts = parseShell(command);
  const texts = commandTexts(command);
  const denied = policy.deny.find((pattern) =>
    texts.some((t) => matchesPattern(pattern, t)),
  );
  if (denied !== undefined) {
    return {
      verdict: 'deny',
      reasons: [`matches deny pattern "${denied}"`],
      destructive: false,
    };
  }
  const reasons = destructiveReasons(command, {
    projectRoot: policy.projectRoot,
    ...(policy.home !== undefined && { home: policy.home }),
  });
  if (reasons.length > 0) return { verdict: 'ask', reasons, destructive: true };
  if (mode === 'full-oven')
    return { verdict: 'allow', reasons: [], destructive: false };
  if (mode === 'taste')
    return { verdict: 'ask', reasons: [], destructive: false };
  const allowed =
    parts.length > 0 &&
    parts.every(
      (p) =>
        !p.substitution &&
        policy.allow.some((pattern) => matchesPattern(pattern, p.text)),
    );
  return {
    verdict: allowed ? 'allow' : 'ask',
    reasons: [],
    destructive: false,
  };
}

/** Any tool call: reads always run, file edits ask only in taste, shell per decideShell. */
export function decide(
  tool: Pick<Tool, 'kind'>,
  args: unknown,
  mode: OvenMode,
  policy: Policy,
): Decision {
  const command = shellCommand(tool, args);
  if (command !== null) return decideShell(command, mode, policy);
  if (tool.kind === 'shell')
    return { verdict: 'ask', reasons: [], destructive: false };
  if (tool.kind === 'write' && mode === 'taste')
    return { verdict: 'ask', reasons: [], destructive: false };
  return { verdict: 'allow', reasons: [], destructive: false };
}

function deniedResult(decision: Decision): ToolResult {
  return {
    ok: false,
    output: `Not allowed: this command ${decision.reasons.join('; ')} in cookie.toml [permissions].`,
    hint: 'Do not retry it or a variant of it. Find another way, or tell the user what you needed.',
    summary: 'denied by [permissions]',
  };
}

export const NEEDS_APPROVAL = 'Needs approval; rerun with --yes';

/**
 * Headless mode has no one to ask: file changes and shell commands run only with --yes, deny
 * patterns always refuse, and destructive commands are refused even with --yes, because they
 * always need a person to say yes to that exact command.
 */
export function headlessGate(
  yes: boolean,
  policy: Policy,
): (tool: Tool, args: unknown) => ToolResult | null {
  return (tool, args) => {
    if (tool.kind !== 'write' && tool.kind !== 'shell') return null;
    const decision = decide(tool, args, 'full-oven', policy);
    if (decision.verdict === 'deny') return deniedResult(decision);
    if (decision.destructive) {
      return {
        ok: false,
        output: `Not run: destructive commands always need a person to approve them (${decision.reasons.join('; ')}).`,
        hint: 'Headless runs never run these. Leave it out, and say in your summary what you would have run.',
        summary: 'destructive, not run',
      };
    }
    if (yes) return null;
    return {
      ok: false,
      output: `${NEEDS_APPROVAL}.`,
      hint:
        'This headless run may only read: file changes and shell commands were not allowed. ' +
        'Carry on with read-only tools, and say in your summary what you could not do.',
      summary: 'needs approval (--yes)',
    };
  };
}

export interface InteractiveGateOptions {
  mode: () => OvenMode;
  policy: Policy;
  /** Shows the approval card and resolves with the user's answer. */
  ask: (request: ApprovalRequest) => Promise<Answer>;
}

/**
 * The interactive gate: decides, and asks through the approval card when it must. "Always"
 * answers last for the session: all file edits, or that exact shell command. Destructive
 * commands never get an "always".
 */
export function interactiveGate({
  mode,
  policy,
  ask,
}: InteractiveGateOptions): ToolGate {
  let editsAlways = false;
  const commandsAlways = new Set<string>();
  return async (tool, args) => {
    const decision = decide(tool, args, mode(), policy);
    if (decision.verdict === 'allow') return null;
    if (decision.verdict === 'deny') return deniedResult(decision);
    const command = shellCommand(tool, args);
    if (!decision.destructive) {
      if (command === null && editsAlways) return null;
      if (command !== null && commandsAlways.has(command.trim())) return null;
    }
    const answer = await ask({
      tool: tool.name,
      kind: command === null ? 'write' : 'shell',
      args,
      command,
      destructive: decision.destructive,
      reasons: decision.reasons,
      canAlways: !decision.destructive,
    });
    switch (answer.kind) {
      case 'always':
        if (command === null) editsAlways = true;
        else commandsAlways.add(command.trim());
        return null;
      case 'yes':
        return null;
      case 'edit': {
        // The user wrote it, so it needs no second yes, but the deny list still wins.
        const edited = decideShell(answer.command, mode(), policy);
        if (edited.verdict === 'deny') return deniedResult(edited);
        return { editedArgs: { ...(args as object), command: answer.command } };
      }
      case 'no':
        return declined(answer.reason, answer.interrupted === true);
    }
  };
}

function declined(
  reason: string | undefined,
  interrupted: boolean,
): ToolResult {
  if (interrupted) {
    return {
      ok: false,
      output: 'Interrupted by user before this ran.',
      summary: 'interrupted',
    };
  }
  const said = reason?.trim() ? ` They said: "${reason.trim()}"` : '';
  return {
    ok: false,
    output: `The user declined this.${said}`,
    hint: 'Do not retry the same call. Adjust your approach to what they said, or ask them.',
    summary: 'declined',
  };
}
