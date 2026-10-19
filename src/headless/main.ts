import { findRepoRoot, loadConfig } from '../config/load.ts';
import type { FetchLike } from '../provider/client.ts';
import { prepareProvider } from '../provider/startup.ts';
import { bindStream } from '../provider/stream.ts';
import { SessionLog } from '../storage/sessionLog.ts';
import { realRoot } from '../tools/paths.ts';
import type { Tool } from '../tools/types.ts';
import { EXIT, type Write } from './format.ts';
import { runHeadless } from './run.ts';

export interface HeadlessFlags {
  task: string;
  json: boolean;
  yes: boolean;
  /** A model id to use instead of the main role's (scripts/record.ts). Must be in the catalog. */
  model?: string;
  maxTurns?: number;
}

export interface HeadlessIo {
  out: Write;
  err: Write;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Where the user cookie.toml is looked up; the real home by default. */
  home?: string;
  /** Wraps every provider request: scripts/record.ts records through it, tests fake it. */
  fetch?: FetchLike;
  /** Model catalog cache file, so a recording run never touches ~/.cache. */
  catalogCache?: string;
  /** Extra tools beside the default five (scripts/probe-quirks.ts). */
  tools?: Tool[];
  /** Write a session log; on by default. */
  sessionLog?: boolean;
}

/**
 * First Ctrl-C stops the run cleanly (every tool call still gets answered); a second one,
 * for when a stop hangs, exits at once.
 */
export function interruptHandler(
  controller: AbortController,
  exitNow: () => void,
): () => void {
  return () => {
    if (controller.signal.aborted) exitNow();
    else controller.abort();
  };
}

/** `cookie -p`: config, provider, then the loop with the main-role model. */
export async function headlessMain(
  flags: HeadlessFlags,
  io: HeadlessIo,
): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const loaded = loadConfig({
    cwd,
    ...(io.home !== undefined && { home: io.home }),
  });
  if (!loaded.ok) {
    io.err(`${loaded.message}\n`);
    return EXIT.error;
  }
  const { config } = loaded;

  const controller = new AbortController();
  const onSigint = interruptHandler(controller, () => {
    io.err('cookie: interrupted twice; exiting now.\n');
    process.exit(EXIT.error);
  });
  process.on('SIGINT', onSigint);
  try {
    const provider = await prepareProvider(config, {
      signal: controller.signal,
      ...(io.env !== undefined && { env: io.env }),
      ...(io.fetch !== undefined && { fetch: io.fetch }),
      ...(io.catalogCache !== undefined && { cacheFile: io.catalogCache }),
    });
    if (!provider.ok) {
      io.err(`${provider.message}\n`);
      return EXIT.error;
    }
    const model = flags.model ?? config.models[config.roles.main];
    // Configured models were checked by prepareProvider; an override (scripts) is checked here.
    if (
      flags.model !== undefined &&
      provider.catalog.getModel(model) === undefined
    ) {
      io.err(
        `cookie: ${model} is not in Command Code's model catalog. Available: ${provider.catalog.ids().join(', ')}\n`,
      );
      return EXIT.error;
    }
    const projectRoot = findRepoRoot(cwd);
    return await runHeadless({
      task: flags.task,
      json: flags.json,
      yes: flags.yes,
      model,
      stream: bindStream(provider.client),
      projectRoot,
      ...(io.sessionLog !== false && {
        log: new SessionLog({ projectRoot: realRoot(projectRoot), model }),
      }),
      ...(io.tools !== undefined && { extraTools: io.tools }),
      maxTurns: flags.maxTurns ?? config.limits.max_turns,
      permissions: config.permissions,
      out: io.out,
      err: io.err,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}
