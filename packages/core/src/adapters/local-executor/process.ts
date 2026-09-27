import { spawn } from 'node:child_process';

/** What a finished child process produced. `exitCode` is null when a signal killed it. */
export interface ProcessOutput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly cwd: string;
  /** Extra variables on top of the sanitized parent environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Starts `file` with `args` (never through a shell), waits for it, and captures both streams in
 * full. Rejects only when the process cannot be spawned.
 */
export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: ProcessOptions,
) => Promise<ProcessOutput>;

/**
 * Variables that point git at another repository. They are set, for example, when Placebo runs
 * inside a git hook, and would make every git command in a snapshot or run folder act on the
 * wrong repository.
 */
const GIT_LOCATION_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

/** The parent environment without git location variables, plus `extra`. */
export function childEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARIABLES.includes(name)),
  );
  return { ...env, ...extra };
}

export const spawnProcess: ProcessRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: childEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
