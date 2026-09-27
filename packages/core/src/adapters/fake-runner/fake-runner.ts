import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type {
  Outcome,
  PermissionDenial,
  ResultEvent,
  RunnerEvent,
  TokenUsage,
} from '../../domain/events.js';
import type { Clock } from '../../kernel/clock.js';
import {
  RunnerInfraError,
  type RunRequest,
  type Runner,
  type RunnerResult,
} from '../../ports/runner.js';

/** One scripted step of a fake run. */
export type FakeStep =
  /** An `assistant_text` event. */
  | { readonly text: string }
  /** A `tool_call` event followed by its `tool_result` (output defaults to `''`). */
  | {
      readonly tool: string;
      readonly input: unknown;
      readonly output?: string;
      readonly isError?: boolean;
    }
  /** Writes a file under `request.cwd` (no event), so the change is real. */
  | { readonly write: { readonly path: string; readonly content: string } }
  /** Deletes a file under `request.cwd` (no event). */
  | { readonly delete: string }
  /** A `usage` event: the tokens of one assistant turn. */
  | { readonly usage: TokenUsage };

/** The final `result` event; every field defaults to a successful, free, instant run. */
export interface FakeResult {
  readonly outcome?: Outcome;
  readonly costUsd?: number;
  /** Defaults to the number of `usage` steps, at least 1. */
  readonly turns?: number;
  readonly durationMs?: number;
  readonly apiDurationMs?: number;
  readonly stopReason?: string | null;
  readonly permissionDenials?: readonly PermissionDenial[];
  /** The schema-enforced answer, for judge requests. */
  readonly structuredOutput?: unknown;
}

/** What the fake agent does for one request. */
export interface FakePlan {
  readonly steps?: readonly FakeStep[];
  readonly result?: FakeResult;
  /** Thrown before any event, on every call. */
  readonly infraError?: RunnerInfraError;
  /** Throw a `RunnerInfraError` on the first `failAttempts` calls with this prompt, then run. */
  readonly failAttempts?: number;
  /** Model reported in `system_init`; defaults to `request.model`. */
  readonly model?: string;
}

export interface FakeRunnerOptions {
  readonly clock: Clock;
  readonly claudeCodeVersion?: string;
  /** Chooses the plan per request, e.g. by `prompt`, `cwd`, `tools` or `outputSchema`. */
  readonly plan: (request: RunRequest) => FakePlan;
}

const TOOLS_BY_MODE: Record<RunRequest['tools'], readonly string[]> = {
  all: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
  read_only: ['Glob', 'Grep', 'Read'],
  none: [],
};

const ONE_TURN: TokenUsage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 };

/**
 * A deterministic, scriptable `Runner` that spends zero tokens. Each request is answered by the
 * `FakePlan` the `plan` function returns: steps become events in order, `write` and `delete`
 * steps really mutate files under `request.cwd`, `system_init` comes first and `result` last,
 * and every timestamp comes from the injected clock. `requests` logs every request received,
 * including ones that threw.
 */
export class FakeRunner implements Runner {
  /** Ready-made plans. */
  static readonly plans = {
    /** Reads `path`, edits it to `content` (really writing the file), and completes. */
    editFile(path: string, content: string): FakePlan {
      return {
        steps: [
          { text: `Reading ${path}.` },
          { tool: 'Read', input: { file_path: path } },
          { usage: ONE_TURN },
          { tool: 'Edit', input: { file_path: path, new_string: content } },
          { write: { path, content } },
          { usage: ONE_TURN },
          { text: 'Done.' },
        ],
        result: { costUsd: 0.01, durationMs: 1_000, apiDurationMs: 800 },
      };
    },
    /** A one-turn judge answer carrying `structuredOutput`. */
    judgeAnswer(structuredOutput: unknown): FakePlan {
      return { steps: [{ usage: ONE_TURN }], result: { structuredOutput } };
    },
  };

  readonly requests: RunRequest[] = [];
  readonly #clock: Clock;
  readonly #version: string;
  readonly #plan: (request: RunRequest) => FakePlan;
  readonly #attempts = new Map<string, number>();

  constructor(options: FakeRunnerOptions) {
    this.#clock = options.clock;
    this.#version = options.claudeCodeVersion ?? '2.1.283';
    this.#plan = options.plan;
  }

  claudeCodeVersion(): Promise<string> {
    return Promise.resolve(this.#version);
  }

  async run(request: RunRequest, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    this.requests.push(request);
    const plan = this.#plan(request);
    if (plan.infraError) throw plan.infraError;
    const attempt = (this.#attempts.get(request.prompt) ?? 0) + 1;
    this.#attempts.set(request.prompt, attempt);
    if (attempt <= (plan.failAttempts ?? 0)) {
      throw new RunnerInfraError('rate_limited', `fake rate limit on attempt ${String(attempt)}`);
    }

    const now = (): string => this.#clock.now().toISOString();
    const model = plan.model ?? request.model;
    const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let turns = 0;
    let callCount = 0;

    onEvent({
      type: 'system_init',
      timestamp: now(),
      model,
      claudeCodeVersion: this.#version,
      tools: [...TOOLS_BY_MODE[request.tools]],
    });

    for (const step of plan.steps ?? []) {
      if ('text' in step) {
        onEvent({ type: 'assistant_text', timestamp: now(), text: step.text });
      } else if ('tool' in step) {
        callCount += 1;
        const id = `fake-tool-${String(callCount)}`;
        onEvent({ type: 'tool_call', timestamp: now(), id, name: step.tool, input: step.input });
        onEvent({
          type: 'tool_result',
          timestamp: now(),
          id,
          output: step.output ?? '',
          isError: step.isError ?? false,
        });
      } else if ('write' in step) {
        const target = inside(request.cwd, step.write.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, step.write.content);
      } else if ('delete' in step) {
        await rm(inside(request.cwd, step.delete), { force: true, recursive: true });
      } else {
        turns += 1;
        usage.input += step.usage.input;
        usage.output += step.usage.output;
        usage.cacheRead += step.usage.cacheRead;
        usage.cacheWrite += step.usage.cacheWrite;
        onEvent({ type: 'usage', timestamp: now(), ...step.usage });
      }
    }

    const scripted = plan.result ?? {};
    const result: ResultEvent = {
      type: 'result',
      timestamp: now(),
      outcome: scripted.outcome ?? 'completed',
      costUsd: scripted.costUsd ?? 0,
      turns: scripted.turns ?? Math.max(turns, 1),
      durationMs: scripted.durationMs ?? 0,
      apiDurationMs: scripted.apiDurationMs ?? 0,
      stopReason: scripted.stopReason === undefined ? 'end_turn' : scripted.stopReason,
      permissionDenials: [...(scripted.permissionDenials ?? [])],
      ...('structuredOutput' in scripted ? { structuredOutput: scripted.structuredOutput } : {}),
    };
    onEvent(result);
    return { result, usage, model, claudeCodeVersion: this.#version };
  }
}

/** Resolves `path` under `cwd`, refusing paths that escape it (a bug in the test's plan). */
function inside(cwd: string, path: string): string {
  const target = resolve(cwd, path);
  const rel = relative(cwd, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`fake runner: path "${path}" is outside the run folder`);
  }
  return target;
}
