import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  type Clock,
  type RunRequest,
  type Runner,
  RunnerInfraError,
  type RunnerEvent,
  type RunnerResult,
  systemClock,
} from '@placebo-eval/core';
import { childEnv } from '../sdk-runner/env.js';
import { READ_ONLY_TOOLS } from '../sdk-runner/sdk-runner.js';
import { infraErrorFrom, StreamProtocolError, StreamTranslator } from '../sdk-runner/stream.js';
import { subjectDisallowedTools, subjectEnv } from '../subject-tools.js';

// The fallback runner: the user's installed `claude` in print mode with streamed JSON (brief §7).
// `claude -p --output-format stream-json` prints the same messages the Agent SDK yields, so the
// translation is shared with the SDK runner. Unlike the SDK runner it drives whatever Claude Code
// version is installed, and records it from `claude --version`.

export type SpawnFunction = typeof nodeSpawn;

/** Keeps the last few KB of stderr for error messages. */
const STDERR_TAIL_BYTES = 4096;

/** The `claude` argv for a request, prompt last after `--` so it is never read as a flag. */
export function cliArgs(request: RunRequest): string[] {
  const maxTurns = request.maxTurns ?? request.limits.maxTurns;
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // Final per-turn usage only arrives on `message_delta` stream events.
    '--include-partial-messages',
    '--model',
    request.model,
    '--setting-sources',
    request.settingSources.join(','),
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
  ];
  if (request.strictMcpConfig) args.push('--strict-mcp-config');
  if (request.sandbox) {
    // No sandbox flag exists for print mode; the same settings the SDK option sets go in the
    // highest-priority settings layer instead.
    args.push(
      '--settings',
      JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }),
    );
  }
  if (maxTurns !== undefined) args.push('--max-turns', String(maxTurns));
  if (request.limits.maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(request.limits.maxBudgetUsd));
  }
  if (request.outputSchema !== undefined) {
    args.push('--json-schema', JSON.stringify(request.outputSchema));
  }
  if (request.systemPrompt !== undefined) args.push('--append-system-prompt', request.systemPrompt);
  switch (request.tools) {
    case 'all':
      break;
    case 'subject':
      args.push('--disallowedTools', subjectDisallowedTools().join(','));
      break;
    case 'none':
      args.push('--tools', '', '--disallowedTools', 'mcp__*');
      break;
    case 'read_only':
      args.push(
        '--tools',
        READ_ONLY_TOOLS.join(','),
        '--allowedTools',
        READ_ONLY_TOOLS.join(','),
        '--disallowedTools',
        'mcp__*',
      );
      break;
  }
  args.push('--', request.prompt);
  return args;
}

/** Parses `2.1.283 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | undefined {
  return /^\s*(\d+\.\d+\.\d+)/.exec(output)?.[1];
}

export interface CliRunnerOptions {
  readonly executable?: string;
  readonly spawn?: SpawnFunction;
  readonly clock?: Clock;
  /** The environment the child inherits, before parent-session variables are removed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Exit {
  readonly code: number | null;
  readonly spawnError: Error | undefined;
  readonly stderr: string;
}

export class CliRunner implements Runner {
  readonly #executable: string;
  readonly #spawn: SpawnFunction;
  readonly #clock: Clock;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(options: CliRunnerOptions = {}) {
    this.#executable = options.executable ?? 'claude';
    this.#spawn = options.spawn ?? nodeSpawn;
    this.#clock = options.clock ?? systemClock;
    this.#env = options.env ?? process.env;
  }

  async claudeCodeVersion(): Promise<string> {
    const lines: string[] = [];
    const exit = await this.#exec(['--version'], process.cwd(), {}, undefined, (line) => {
      lines.push(line);
    });
    const version = parseClaudeVersion(lines.join('\n'));
    if (exit.spawnError !== undefined || exit.code !== 0 || version === undefined) {
      throw new RunnerInfraError(
        'spawn_failed',
        `\`${this.#executable} --version\` failed: ${exit.spawnError?.message ?? (exit.stderr || lines.join('\n'))}`,
        exit.spawnError === undefined ? undefined : { cause: exit.spawnError },
      );
    }
    return version;
  }

  async run(request: RunRequest, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    const { signal } = request;
    // A function, not the property: flow analysis would pin `aborted` to its first reading.
    const aborted = (): boolean => signal?.aborted === true;
    if (aborted()) throw signal?.reason;
    const translator = new StreamTranslator(this.#clock, onEvent);
    // Objects, not `let`s: callbacks mutate them, which flow analysis cannot see. A run cut short
    // by the time limit or by `signal` is `failed`.
    const failure: { error?: Error } = {};
    const deadline = { timedOut: false };
    const exit = await this.#exec(
      cliArgs(request),
      request.cwd,
      subjectEnv(request),
      request.limits.maxDurationMs,
      (line, kill) => {
        if (failure.error !== undefined) return;
        const message = parseLine(line);
        if (message === undefined) return;
        try {
          translator.push(message);
        } catch (error) {
          failure.error =
            error instanceof StreamProtocolError ? error : new StreamProtocolError(String(error));
          kill();
        }
      },
      () => (deadline.timedOut = true),
      signal,
    );
    if (failure.error !== undefined) throw failure.error;
    if (exit.spawnError !== undefined) {
      throw new RunnerInfraError(
        'spawn_failed',
        `could not start \`${this.#executable}\`: ${exit.spawnError.message}`,
        { cause: exit.spawnError },
      );
    }
    if (translator.hasResult) return translator.finish({ timedOut: deadline.timedOut });
    if (!translator.started && aborted()) throw signal?.reason;
    if (!deadline.timedOut) {
      const infra = infraErrorFrom(exit.stderr);
      if (infra !== undefined) throw infra;
    }
    if (!translator.started) {
      throw new RunnerInfraError(
        'spawn_failed',
        `\`${this.#executable}\` exited with code ${String(exit.code)} before any output: ${exit.stderr.trim()}`,
      );
    }
    return translator.synthesize(deadline.timedOut ? 'failed' : 'crashed');
  }

  /**
   * Spawns the executable and feeds each stdout line to `onLine`; never rejects. The time limit
   * and `signal` both call `onTimeout` and kill the child.
   */
  #exec(
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
    maxDurationMs: number | undefined,
    onLine: (line: string, kill: () => void) => void,
    onTimeout?: () => void,
    signal?: AbortSignal,
  ): Promise<Exit> {
    return new Promise((resolve) => {
      let stderr = '';
      let spawnError: Error | undefined;
      let child;
      try {
        child = this.#spawn(this.#executable, args, {
          cwd,
          env: { ...childEnv(this.#env), ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ code: null, spawnError: toError(error), stderr });
        return;
      }
      const kill = (): void => {
        child.kill('SIGTERM');
      };
      const cutShort = (): void => {
        onTimeout?.();
        kill();
      };
      const timer = maxDurationMs === undefined ? undefined : setTimeout(cutShort, maxDurationMs);
      signal?.addEventListener('abort', cutShort, { once: true });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        onLine(line, kill);
      });
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cutShort);
        resolve({ code, spawnError, stderr });
      });
    });
  }
}

function parseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
