import { afterEach } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { realRoot } from '../../src/tools/paths.ts';
import type {
  ReadLedger,
  Tool,
  ToolContext,
  ToolResult,
} from '../../src/tools/types.ts';

export const IS_WINDOWS = process.platform === 'win32';

const created: string[] = [];

/**
 * Call at the top of each test file. Bun shares one module instance across files, so a
 * top-level afterEach here would attach to the first importing file only.
 */
export function useTempProjects(): void {
  afterEach(() => {
    for (const dir of created.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
}

export interface TempProject {
  /** Real path of the project root. */
  root: string;
  /** A sibling directory outside the root, for escape tests. */
  outside: string;
  ledger: ReadLedger;
  ctx(signal?: AbortSignal): ToolContext;
  path(rel: string): string;
  write(rel: string, content: string | Uint8Array): void;
  read(rel: string): string;
  /** Sets mtime explicitly, so "changed on disk" never depends on timestamp resolution. */
  touch(rel: string, mtimeSeconds: number): void;
}

/** A fresh temp directory per test, removed afterwards. */
export function tempProject(
  files: Record<string, string | Uint8Array> = {},
): TempProject {
  const base = realRoot(mkdtempSync(join(tmpdir(), 'cookie-tools-')));
  created.push(base);
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  const ledger: ReadLedger = new Map();
  const project: TempProject = {
    root,
    outside,
    ledger,
    ctx: (signal = new AbortController().signal) => ({
      projectRoot: root,
      signal,
      readLedger: ledger,
    }),
    path: (rel) => join(root, rel),
    write: (rel, content) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    },
    read: (rel) => readFileSync(join(root, rel), 'utf8'),
    touch: (rel, mtimeSeconds) =>
      utimesSync(join(root, rel), mtimeSeconds, mtimeSeconds),
  };
  for (const [rel, content] of Object.entries(files))
    project.write(rel, content);
  return project;
}

/** Calls a tool through its schema, the way the registry would. */
export function call<T extends Tool>(
  tool: T,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  return tool.run(tool.schema.parse(args), ctx);
}
