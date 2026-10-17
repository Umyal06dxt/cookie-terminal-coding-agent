import { render, useApp, useWindowSize } from 'ink';
import { type ReactElement, useMemo, useState } from 'react';
import {
  buildSystemPrompt,
  collectEnvironment,
  gitBranch,
} from '../agent/prompts/system.ts';
import type { ResumeMode } from '../cli.ts';
import { findRepoRoot, loadConfig } from '../config/load.ts';
import { prepareProvider } from '../provider/startup.ts';
import { bindStream } from '../provider/stream.ts';
import { Approvals } from '../safety/approvals.ts';
import {
  interactiveGate,
  type OvenMode,
  policyFrom,
} from '../safety/permissions.ts';
import { SessionLog } from '../storage/sessionLog.ts';
import {
  recentSessions,
  restoreMessages,
  type SessionSummary,
} from '../storage/sessions.ts';
import { projectFiles } from '../tools/glob.ts';
import { createDefaultRegistry } from '../tools/index.ts';
import { realRoot } from '../tools/paths.ts';
import type { ReadLedger } from '../tools/types.ts';
import { App } from './app.tsx';
import { SessionPicker } from './components/session-picker.tsx';
import type { BackendResult } from './controller.ts';
import { replayState } from './restore.ts';
import type { StatusInfo } from './state.ts';
import { displayFolder } from './status.ts';
import { createTheme, ThemeContext } from './theme.ts';

/** --resume: the session list first, then the app with the chosen session. */
function ResumeThenApp({
  sessions,
  open,
}: {
  sessions: SessionSummary[];
  open: (session: SessionSummary) => ReactElement;
}) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [chosen, setChosen] = useState<SessionSummary | null>(null);
  // Opened once: open() reopens the log file, which must not happen on every render.
  const opened = useMemo(() => (chosen ? open(chosen) : null), [chosen, open]);
  if (opened) return opened;
  return (
    <SessionPicker
      sessions={sessions}
      width={columns}
      onPick={setChosen}
      onCancel={exit}
    />
  );
}

/** The status bar shows no branch outside a git repository. */
function branchLabel(root: string): string {
  const branch = gitBranch(root);
  return branch === 'not a git repository' ? '' : branch;
}

export interface InteractiveIo {
  err: (text: string) => void;
  version: string;
  cwd?: string;
  /** --resume (pick) or --continue (latest). */
  resume?: ResumeMode;
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
  const status: StatusInfo = {
    model,
    folder: displayFolder(projectRoot),
    branch: branchLabel(projectRoot),
    contextWindow: null,
    price: config.pricing[model] ?? null,
  };
  const logOptions = { projectRoot, model };

  /** The app, fresh or continuing a logged session. */
  const app = (session: SessionSummary | null) => {
    const resume = session
      ? {
          state: replayState(session.records, status),
          messages: restoreMessages(session.records),
        }
      : undefined;
    const log =
      session && resume
        ? SessionLog.reopen(logOptions, session.path, resume.messages.length)
        : new SessionLog(logOptions);
    return (
      <App
        status={status}
        ready={ready}
        listFiles={() => projectFiles(projectRoot)}
        oven={oven}
        approvals={approvals}
        version={io.version}
        log={log}
        {...(resume !== undefined && { resume })}
      />
    );
  };

  let first: ReactElement;
  if (io.resume) {
    const sessions = recentSessions(
      projectRoot,
      config.pricing,
      io.resume === 'latest' ? 1 : 10,
    );
    const newest = sessions[0];
    if (!newest) {
      startup.abort();
      io.err(
        `cookie: no saved sessions in ${displayFolder(projectRoot)} yet.\n`,
      );
      return 1;
    }
    first =
      io.resume === 'latest' ? (
        app(newest)
      ) : (
        <ResumeThenApp sessions={sessions} open={app} />
      );
  } else {
    first = app(null);
  }

  const instance = render(
    <ThemeContext.Provider value={theme}>{first}</ThemeContext.Provider>,
    { exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    startup.abort();
  }
  return 0;
}
