# Cookie — rules for Claude Code

Cookie is a terminal coding agent (TypeScript, Bun, Ink) on the Command Code Provider API.
Spec: docs/design.md. Progress: PROGRESS.md. Read both before starting any task.

## Commands
- install: bun install
- dev: bun run dev            (runs src/cli.ts)
- test: bun test              one file: bun test test/path/to/file.test.ts
- typecheck: bun run typecheck
- lint: bun run lint          (Biome)

## Rules
- TypeScript strict. No `any`, no `@ts-ignore`, no `!` non-null assertions without a comment saying why.
- Every module ships with tests in the same change. Never weaken, skip or delete a test to make it pass.
- Tests never call the real API. Use test/fake-model.ts and recorded fixtures in test/fixtures/.
- No new dependencies without asking. Already allowed: ink, react, openai, zod, smol-toml, diff,
  web-tree-sitter, @biomejs/biome, ink-testing-library.
- Tool results sent to the model never start with "Error:". They state what happened and how to recover.
- Pure logic stays out of src/ui so it can be tested without a terminal.
- Files stay under ~300 lines; split by responsibility.
- Never read, print or log COMMANDCODE_API_KEY or any .env file.
- When a task is done, append one line to PROGRESS.md: date · step · what changed · what's left.

## Layout
src/cli.ts            entry point, argument parsing
src/config/           cookie.toml loading and schema
src/provider/         Command Code client, model catalog, streaming, per-model quirks
src/agent/            the loop, events, session, budgets, compaction, system prompt
src/tools/            tool registry, repair layer, one file per tool
src/safety/           permissions, checkpoints, secret scrubbing
src/router/           roles and model routing
src/index/            code index (file map, symbols, imports, repo map)
src/tray/             planner, scheduler, worktrees, merge, best-of-N
src/storage/          session logs (JSONL), SQLite helpers
src/ui/               Ink components, theme, Chip, games
src/headless/         -p mode and JSON event output
test/                 mirrors src/, plus fake-model.ts and fixtures/
bench/                cookie-bench tasks, runner, reports