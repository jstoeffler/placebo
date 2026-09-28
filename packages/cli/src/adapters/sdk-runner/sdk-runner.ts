import { readFile } from 'node:fs/promises';
import { type Options, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import {
  type Clock,
  type RunRequest,
  type Runner,
  type RunnerEvent,
  type RunnerResult,
  systemClock,
} from '@placebo-eval/core';
import { z } from 'zod';
import { subjectDisallowedTools, subjectEnv } from '../subject-tools.js';
import { childEnv } from './env.js';
import { classifyThrown, infraErrorFrom, StreamProtocolError, StreamTranslator } from './stream.js';

/** The part of the SDK's `query` a runner uses; tests inject a fake yielding recorded messages. */
export type QueryFunction = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<unknown>;

/** The only tools a `read_only` judge may use (brief §9, ADR 0007). */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Maps a `RunRequest` to Agent SDK options. Every key is explicit so the options object can be
 * asserted in tests; keys for limits the request does not carry are absent (ADR 0008).
 */
function sdkOptions(
  request: RunRequest,
  env: Record<string, string>,
  abortController?: AbortController,
): Options {
  const maxTurns = request.maxTurns ?? request.limits.maxTurns;
  const options: Options = {
    cwd: request.cwd,
    model: request.model,
    settingSources: [...request.settingSources],
    strictMcpConfig: request.strictMcpConfig,
    // Runs never block on a prompt; the sandbox is what confines them (brief §7).
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // Without the preset the SDK uses a minimal prompt, unlike `claude -p`.
    systemPrompt:
      request.systemPrompt === undefined
        ? { type: 'preset', preset: 'claude_code' }
        : { type: 'preset', preset: 'claude_code', append: request.systemPrompt },
    env,
    // Needed for final per-turn usage, which only `message_delta` stream events carry.
    includePartialMessages: true,
    ...toolOptions(request.tools),
  };
  if (request.sandbox) {
    // Network stays allowed (brief §7). Commands may not ask to leave the sandbox: with
    // permissions bypassed that request would be granted silently.
    options.sandbox = { enabled: true, allowUnsandboxedCommands: false };
  }
  if (maxTurns !== undefined) options.maxTurns = maxTurns;
  if (request.limits.maxBudgetUsd !== undefined) options.maxBudgetUsd = request.limits.maxBudgetUsd;
  if (request.outputSchema !== undefined) {
    options.outputFormat = { type: 'json_schema', schema: { ...request.outputSchema } };
  }
  if (abortController !== undefined) options.abortController = abortController;
  return options;
}

function toolOptions(tools: RunRequest['tools']): Partial<Options> {
  switch (tools) {
    case 'all':
      return {};
    case 'subject':
      return { disallowedTools: subjectDisallowedTools() };
    case 'none':
      return { tools: [], disallowedTools: ['mcp__*'] };
    case 'read_only':
      return {
        tools: [...READ_ONLY_TOOLS],
        allowedTools: [...READ_ONLY_TOOLS],
        disallowedTools: ['mcp__*'],
      };
  }
}

const Manifest = z.looseObject({ version: z.string().regex(/^\d+\.\d+\.\d+/) });

/**
 * The Claude Code version bundled with the installed SDK. The SDK package is versioned
 * `0.3.x` and ships Claude Code `2.1.x`; the bundled binary's version is in `manifest.json`.
 */
export async function bundledClaudeCodeVersion(): Promise<string> {
  const manifestUrl = new URL(
    'manifest.json',
    import.meta.resolve('@anthropic-ai/claude-agent-sdk'),
  );
  const manifest = Manifest.parse(JSON.parse(await readFile(manifestUrl, 'utf8')));
  return manifest.version;
}

export interface SdkRunnerOptions {
  readonly query?: QueryFunction;
  readonly clock?: Clock;
  /** The environment the child inherits, before parent-session variables are removed. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The default runner: Claude Code driven through `query()` from the Agent SDK (brief §7). */
export class SdkRunner implements Runner {
  readonly #query: QueryFunction;
  readonly #clock: Clock;
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(options: SdkRunnerOptions = {}) {
    this.#query = options.query ?? sdkQuery;
    this.#clock = options.clock ?? systemClock;
    this.#env = options.env ?? process.env;
  }

  claudeCodeVersion(): Promise<string> {
    return bundledClaudeCodeVersion();
  }

  async run(request: RunRequest, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult> {
    const { signal } = request;
    if (signal?.aborted === true) throw signal.reason;
    const translator = new StreamTranslator(this.#clock, onEvent);
    const { maxDurationMs } = request.limits;
    const controller =
      maxDurationMs === undefined && signal === undefined ? undefined : new AbortController();
    // An object, not a `let`: the timer and abort callbacks mutate it, which flow analysis cannot
    // see. A run cut short by the time limit or by `signal` is `failed`.
    const deadline = { timedOut: false };
    const cutShort = (): void => {
      deadline.timedOut = true;
      controller?.abort();
    };
    const timer = maxDurationMs === undefined ? undefined : setTimeout(cutShort, maxDurationMs);
    signal?.addEventListener('abort', cutShort, { once: true });
    const notStarted = (error: unknown): unknown =>
      signal?.aborted === true ? signal.reason : classifyThrown(error);
    const env = { ...childEnv(this.#env), ...subjectEnv(request) };
    const options = sdkOptions(request, env, controller);
    try {
      for await (const message of this.#query({ prompt: request.prompt, options })) {
        translator.push(message);
      }
    } catch (error) {
      if (error instanceof StreamProtocolError) throw error;
      // The SDK throws after yielding an error result; that result is the outcome.
      if (!translator.hasResult) {
        if (!translator.started) throw notStarted(error);
        if (!deadline.timedOut) {
          const text = error instanceof Error ? error.message : String(error);
          const retry = translator.lastRetryDelayMs;
          const infra = infraErrorFrom(text, {
            cause: error,
            ...(retry === undefined ? {} : { retryAfterMs: retry }),
          });
          if (infra !== undefined) throw infra;
        }
        return translator.synthesize(deadline.timedOut ? 'failed' : 'crashed');
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cutShort);
    }
    if (!translator.started) throw notStarted(new Error('Claude Code exited with no output'));
    if (!translator.hasResult)
      return translator.synthesize(deadline.timedOut ? 'failed' : 'crashed');
    return translator.finish({ timedOut: deadline.timedOut });
  }
}
