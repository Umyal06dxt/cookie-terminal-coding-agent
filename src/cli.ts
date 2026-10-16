#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };

export const USAGE = `cookie ${pkg.version} — a terminal coding agent

Usage:
  cookie [options]

Options:
  -h, --help       Show this help and exit
  -v, --version    Print the version and exit
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

export function run(argv: readonly string[]): CliResult {
  let values: { help?: boolean | undefined; version?: boolean | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return {
      code: 2,
      stdout: '',
      stderr: `${describeParseError(error)}\nRun 'cookie --help' to see the available options.\n`,
    };
  }

  if (values.version) {
    return { code: 0, stdout: `${pkg.version}\n`, stderr: '' };
  }
  return { code: 0, stdout: USAGE, stderr: '' };
}

if (import.meta.main) {
  const result = run(Bun.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
