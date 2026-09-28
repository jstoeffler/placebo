import { homedir } from 'node:os';
import { type Clock, systemClock } from '@placebo-eval/core';
import type { QueryFunction } from './adapters/sdk-runner/sdk-runner.js';

/** Where the program writes; the real process in `index.ts`, buffers in tests. */
export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** Everything a command reads from the process; tests replace any part. */
export interface Host {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly clock: Clock;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly columns: number | undefined;
  /** Calls `handler` on each Ctrl-C until the returned function is called. */
  readonly onInterrupt: (handler: () => void) => () => void;
  /** Ends the process at once (a second Ctrl-C). */
  readonly exit: (code: number) => void;
  /** The built report template; found next to the cli when absent. */
  readonly reportTemplate?: string;
  /** How `init` asks Claude Code for model IDs; the Agent SDK when absent. */
  readonly modelQuery?: QueryFunction;
}

export function processHost(): Host {
  return {
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    clock: systemClock,
    stdoutIsTTY: process.stdout.isTTY,
    stderrIsTTY: process.stderr.isTTY,
    columns: process.stderr.columns,
    onInterrupt: (handler) => {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    },
    exit: (code) => process.exit(code),
  };
}
