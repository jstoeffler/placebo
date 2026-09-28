import type { ResultEvent, RunnerEvent, TokenUsage } from '../domain/events.js';
import type { Limits } from '../domain/suite.js';

/** Claude Code setting sources; `project` must be present for `CLAUDE.md` to load. */
export type SettingSource = 'user' | 'project' | 'local';

/** Isolation default (ADR 0004): only project settings load. */
export const DEFAULT_SETTING_SOURCES: readonly SettingSource[] = ['project'];

/** What to run. Every field is explicit so a stored run can say exactly how it was started. */
export interface RunRequest {
  /** The run folder, or for judges a judge folder from the executor. */
  readonly cwd: string;
  /** Sent bare, with no wrapper. */
  readonly prompt: string;
  /** Full model ID. */
  readonly model: string;
  /** Normally `DEFAULT_SETTING_SOURCES`. */
  readonly settingSources: readonly SettingSource[];
  /** Claude Code's OS sandbox, with permissions bypassed inside it. */
  readonly sandbox: boolean;
  /** Keep personal MCP servers out (ADR 0004). */
  readonly strictMcpConfig: boolean;
  /** The suite's opt-in limits; empty by default (ADR 0008). */
  readonly limits: Limits;
  /** `none` for one-turn judges (ADR 0007); `read_only` (Read, Glob, Grep only) for agentic judges exploring a run folder. */
  readonly tools: 'all' | 'read_only' | 'none';
  /** Overrides `limits.maxTurns`; judges pass 1. */
  readonly maxTurns?: number;
  /** JSON Schema enforcing the final answer; the result carries `structuredOutput`. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Appended to Claude Code's system prompt; judges only. Subject runs never set it. */
  readonly systemPrompt?: string;
  /**
   * Stops the agent when aborted, e.g. on Ctrl-C. The run then resolves with outcome `failed`,
   * like a run cut short by `limits.maxDurationMs`; aborted before the agent started, it rejects
   * with `signal.reason` instead.
   */
  readonly signal?: AbortSignal;
}

export interface RunnerResult {
  /** Identical to the last `result` event emitted. */
  readonly result: ResultEvent;
  /** Sum of all `usage` events. */
  readonly usage: TokenUsage;
  /** Full model ID actually used. */
  readonly model: string;
  readonly claudeCodeVersion: string;
}

/**
 * Starts the agent in a run folder and streams its events (implementations: SDK, installed CLI,
 * fake).
 *
 * Contract:
 * - Emits normalized `RunnerEvent`s in order through `onEvent`; the first is `system_init`, the
 *   last is `result`. Resolves with the same `result` once the agent stops.
 * - Everything the agent does, including failing, crashing or being stopped by a permission
 *   denial, is an `Outcome` in the result, never a rejection.
 * - Throws `RunnerInfraError` only for infrastructure problems: spawn failure, rate limit and
 *   network justify a retry; `auth` (Claude Code is not logged in, the key is invalid, or the
 *   account cannot pay) and `invalid_request` (Claude Code rejected the options or the output
 *   schema of the request) never do. It never retries on its own.
 * - Applies no limits beyond `request.limits` and `request.maxTurns`.
 * - Honours `request.signal`: once it aborts, the agent is stopped and the run resolves with
 *   outcome `failed`; if the agent had not started (no `system_init` yet), it rejects with
 *   `signal.reason`, which is not a `RunnerInfraError` and must not be retried.
 */
export interface Runner {
  run(request: RunRequest, onEvent: (event: RunnerEvent) => void): Promise<RunnerResult>;
  /** The Claude Code version this runner drives, e.g. `2.1.283`. Recorded as a pin. */
  claudeCodeVersion(): Promise<string>;
}

/**
 * Why the infrastructure failed. `auth` covers authentication and billing (HTTP 401 or 403, an
 * invalid API key, not logged in, no credit or quota left). `invalid_request` means Claude Code
 * rejected the request Placebo built before starting (an unknown option, a missing option
 * argument, an output schema it refuses). Retrying can fix neither.
 */
export type RunnerInfraReason =
  'spawn_failed' | 'rate_limited' | 'network' | 'auth' | 'invalid_request' | 'other';

/**
 * An infrastructure failure: the only kind of error that justifies retrying a run, `auth` and
 * `invalid_request` aside.
 */
export class RunnerInfraError extends Error {
  override readonly name = 'RunnerInfraError';
  readonly reason: RunnerInfraReason;
  /** Server-suggested wait before retrying, when known. */
  readonly retryAfterMs: number | undefined;

  constructor(
    reason: RunnerInfraReason,
    message: string,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.retryAfterMs = options?.retryAfterMs;
  }
}
