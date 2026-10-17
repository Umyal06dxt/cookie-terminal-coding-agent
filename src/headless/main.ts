import { findRepoRoot, loadConfig } from '../config/load.ts';
import { prepareProvider } from '../provider/startup.ts';
import { bindStream } from '../provider/stream.ts';
import { EXIT, type Write } from './format.ts';
import { runHeadless } from './run.ts';

export interface HeadlessFlags {
  task: string;
  json: boolean;
  yes: boolean;
}

export interface HeadlessIo {
  out: Write;
  err: Write;
  cwd?: string;
  env?: Record<string, string | undefined>;
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
  const loaded = loadConfig({ cwd });
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
    });
    if (!provider.ok) {
      io.err(`${provider.message}\n`);
      return EXIT.error;
    }
    return await runHeadless({
      ...flags,
      model: config.models[config.roles.main],
      stream: bindStream(provider.client),
      projectRoot: findRepoRoot(cwd),
      maxTurns: config.limits.max_turns,
      out: io.out,
      err: io.err,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
}
