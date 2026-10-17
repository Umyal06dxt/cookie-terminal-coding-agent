#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import { EXIT } from './headless/format.ts';
import { type HeadlessFlags, headlessMain } from './headless/main.ts';

export const USAGE = `cookie ${pkg.version} — a terminal coding agent

Usage:
  cookie              Open the interactive UI (needs a terminal)
  cookie --resume     Pick one of the last 10 sessions in this project and reopen it
  cookie --continue   Reopen the most recent session
  cookie -p "<task>" [--json] [--yes]

Options:
  -p, --print <task>  Run one task headless: text to stdout, tool activity to stderr
      --json          With -p: print one JSON event per line on stdout instead
      --yes           With -p: allow file changes and shell commands without asking
  -r, --resume        Choose a recent session to reopen
  -c, --continue      Reopen the most recent session
  -h, --help          Show this help and exit
  -v, --version       Print the version and exit

Exit codes: 0 done, 1 error or interrupted, 2 bad usage, 3 stopped at max turns.
`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Reads the offending argument out of a node:util parseArgs error, if it names one. */
function describeParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const quoted = /'([^']+)'/.exec(message)?.[1];
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && quoted !== undefined) {
    return `cookie: unknown option '${quoted}'`;
  }
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL' && quoted !== undefined) {
    return `cookie: unexpected argument '${quoted}'`;
  }
  return `cookie: ${message}`;
}

function usageError(message: string): CliResult {
  return {
    code: EXIT.usage,
    stdout: '',
    stderr: `${message}\nRun 'cookie --help' to see the available options.\n`,
  };
}

/** Either an answer to print right away, or a headless task to run. */
export type Parsed =
  | { kind: 'result'; result: CliResult }
  | { kind: 'headless'; flags: HeadlessFlags }
  | { kind: 'interactive'; resume: ResumeMode };

/** --resume picks one of the last sessions; --continue reopens the newest. */
export type ResumeMode = 'pick' | 'latest' | null;

export function parseCli(argv: readonly string[]): Parsed {
  const done = (result: CliResult): Parsed => ({ kind: 'result', result });
  let values: {
    help?: boolean | undefined;
    version?: boolean | undefined;
    print?: string | undefined;
    json?: boolean | undefined;
    yes?: boolean | undefined;
    resume?: boolean | undefined;
    continue?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        print: { type: 'string', short: 'p' },
        json: { type: 'boolean' },
        yes: { type: 'boolean' },
        resume: { type: 'boolean', short: 'r' },
        continue: { type: 'boolean', short: 'c' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return done(usageError(describeParseError(error)));
  }

  if (values.help) return done({ code: 0, stdout: USAGE, stderr: '' });
  if (values.version) {
    return done({ code: 0, stdout: `${pkg.version}\n`, stderr: '' });
  }
  if (values.resume && values.continue) {
    return done(usageError('cookie: use --resume or --continue, not both'));
  }
  if (values.print === undefined) {
    const stray = values.json ? '--json' : values.yes ? '--yes' : null;
    if (stray !== null) {
      return done(usageError(`cookie: ${stray} only works with -p "<task>"`));
    }
    const resume = values.resume ? 'pick' : values.continue ? 'latest' : null;
    return { kind: 'interactive', resume };
  }
  if (values.resume || values.continue) {
    const flag = values.resume ? '--resume' : '--continue';
    return done(
      usageError(
        `cookie: ${flag} opens the interactive UI; it doesn't work with -p`,
      ),
    );
  }
  const task = values.print.trim();
  if (task === '') return done(usageError('cookie: -p needs a task to run'));
  return {
    kind: 'headless',
    flags: { task, json: values.json === true, yes: values.yes === true },
  };
}

if (import.meta.main) {
  const parsed = parseCli(Bun.argv.slice(2));
  if (parsed.kind === 'result') {
    process.stdout.write(parsed.result.stdout);
    process.stderr.write(parsed.result.stderr);
    process.exitCode = parsed.result.code;
  } else if (parsed.kind === 'interactive') {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      // Loaded on demand: Ink and React aren't needed for --version or -p.
      const { interactiveMain } = await import('./ui/main.tsx');
      process.exitCode = await interactiveMain({
        resume: parsed.resume,
        err: (text) => process.stderr.write(text),
        version: pkg.version,
      });
    } else {
      // No terminal to draw on (a pipe or CI): explain instead of failing in raw mode.
      process.stdout.write(USAGE);
      process.stderr.write(
        'cookie: the interactive UI needs a terminal; use -p "<task>" in scripts.\n',
      );
      process.exitCode = EXIT.usage;
    }
  } else {
    // exitCode, not exit(): exit() can cut off output still queued for a pipe.
    process.exitCode = await headlessMain(parsed.flags, {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    });
  }
}
