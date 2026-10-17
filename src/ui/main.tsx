import { render } from 'ink';
import {
  buildSystemPrompt,
  collectEnvironment,
  gitBranch,
} from '../agent/prompts/system.ts';
import { findRepoRoot, loadConfig } from '../config/load.ts';
import { prepareProvider } from '../provider/startup.ts';
import { bindStream } from '../provider/stream.ts';
import { Approvals } from '../safety/approvals.ts';
import {
  interactiveGate,
  type OvenMode,
  policyFrom,
} from '../safety/permissions.ts';
import { projectFiles } from '../tools/glob.ts';
import { createDefaultRegistry } from '../tools/index.ts';
import { realRoot } from '../tools/paths.ts';
import type { ReadLedger } from '../tools/types.ts';
import { App } from './app.tsx';
import type { BackendResult } from './controller.ts';
import { displayFolder } from './status.ts';
import { createTheme, ThemeContext } from './theme.ts';

/** The status bar shows no branch outside a git repository. */
function branchLabel(root: string): string {
  const branch = gitBranch(root);
  return branch === 'not a git repository' ? '' : branch;
}

export interface InteractiveIo {
  err: (text: string) => void;
  version: string;
  cwd?: string;
}

/**
 * `cookie` with no arguments: the full-screen UI. Config errors print before anything draws;
 * the provider connects in the background so the prompt shows at once.
 */
export async function interactiveMain(io: InteractiveIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const loaded = loadConfig({ cwd });
  if (!loaded.ok) {
    io.err(`${loaded.message}\n`);
    return 1;
  }
  const { config } = loaded;
  const projectRoot = realRoot(findRepoRoot(cwd));
  const model = config.models[config.roles.main];

  let mode: OvenMode = config.permissions.mode;
  const oven = {
    get: () => mode,
    set: (next: OvenMode) => {
      mode = next;
    },
  };
  const approvals = new Approvals();
  const readLedger: ReadLedger = new Map();
  const tools = createDefaultRegistry().forAgent(
    { projectRoot, readLedger },
    {
      gate: interactiveGate({
        mode: oven.get,
        policy: policyFrom(config, projectRoot),
        ask: approvals.ask,
      }),
    },
  );

  // Aborted on exit, so a catalog fetch still in flight can't hold the process open.
  const startup = new AbortController();
  const ready: Promise<BackendResult> = prepareProvider(config, {
    signal: startup.signal,
  }).then((provider) => {
    if (!provider.ok) return provider;
    return {
      ok: true,
      backend: {
        model,
        stream: bindStream(provider.client),
        tools,
        systemPrompt: buildSystemPrompt(tools, collectEnvironment(projectRoot))
          .text,
        maxTurns: config.limits.max_turns,
        contextWindow: provider.catalog.getModel(model)?.contextLength ?? null,
      },
    };
  });

  const theme = createTheme({
    mode: config.ui.theme,
    nerdFont: config.ui.nerd_font,
  });
  const instance = render(
    <ThemeContext.Provider value={theme}>
      <App
        status={{
          model,
          folder: displayFolder(projectRoot),
          branch: branchLabel(projectRoot),
          contextWindow: null,
          price: config.pricing[model] ?? null,
        }}
        ready={ready}
        listFiles={() => projectFiles(projectRoot)}
        oven={oven}
        approvals={approvals}
        version={io.version}
      />
    </ThemeContext.Provider>,
    { exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    startup.abort();
  }
  return 0;
}
