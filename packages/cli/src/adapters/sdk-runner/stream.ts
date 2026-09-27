import {
  type Clock,
  type Outcome,
  type ResultEvent,
  RunnerInfraError,
  type RunnerEvent,
  type RunnerResult,
  type TokenUsage,
} from '@placebo-eval/core';
import {
  ApiRetry,
  Assistant,
  Envelope,
  MessageDelta,
  MessageStart,
  type MessageUsage,
  ResultMessage,
  StreamEvent,
  SystemInit,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  User,
} from './messages.js';

// Translates Claude Code's stream messages into `RunnerEvent`s. Shared by the SDK runner, which
// receives the messages as objects, and the CLI runner, which parses them from NDJSON lines.

const ZERO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Assistant errors and HTTP statuses that mean "the API is saturated; try again later". */
const RATE_LIMIT_ERRORS = new Set(['rate_limit', 'overloaded']);
const RATE_LIMIT_STATUSES = new Set([429, 529]);
const RATE_LIMIT_TEXT = /\b(429|529)\b|rate[ _-]?limit|overloaded|too many requests/i;
const NETWORK_TEXT =
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|connection error|network error/i;
const SPAWN_TEXT =
  /ENOENT|EACCES|spawn|executable not found|native binary|failed to start|exited with code/i;

/** What a thrown error or an error result says about infrastructure, if anything. */
export function infraErrorFrom(
  text: string,
  options: { status?: number | null; retryAfterMs?: number; cause?: unknown } = {},
): RunnerInfraError | undefined {
  const retryAfterMs = options.retryAfterMs ?? parseRetryAfterMs(text);
  const retry = retryAfterMs === undefined ? {} : { retryAfterMs };
  const cause = options.cause === undefined ? {} : { cause: options.cause };
  const status = options.status ?? undefined;
  if ((status !== undefined && RATE_LIMIT_STATUSES.has(status)) || RATE_LIMIT_TEXT.test(text))
    return new RunnerInfraError('rate_limited', text, { ...retry, ...cause });
  if (NETWORK_TEXT.test(text)) return new RunnerInfraError('network', text, cause);
  return undefined;
}

/** Reads `retry-after: 30`, `retry after 30 seconds` or `retry in 1500ms` from an error text. */
export function parseRetryAfterMs(text: string): number | undefined {
  const match =
    /retry[- ]?(?:after|in)[:\s]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)?/i.exec(text);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return match[2]?.startsWith('m') === true ? value : value * 1000;
}

/** Classifies an error thrown by the SDK or by spawning `claude`. */
export function classifyThrown(error: unknown): RunnerInfraError {
  if (error instanceof RunnerInfraError) return error;
  const text = error instanceof Error ? `${error.message} ${codeOf(error)}` : String(error);
  const infra = infraErrorFrom(text, { cause: error });
  if (infra !== undefined) return infra;
  if (SPAWN_TEXT.test(text))
    return new RunnerInfraError('spawn_failed', `could not start Claude Code: ${text}`, {
      cause: error,
    });
  return new RunnerInfraError('other', text, { cause: error });
}

function codeOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

function tokenUsage(usage: MessageUsage): TokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content))
    return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((block: unknown) => {
      const text = TextBlock.safeParse(block);
      if (text.success) return text.data.text;
      const type = Envelope.safeParse(block);
      return `[${type.success ? type.data.type : 'unknown'}]`;
    })
    .join('\n');
}

/**
 * The outcome rule. A run cut short by `limits.maxDurationMs` is `failed`. Otherwise the result
 * subtype decides: `success` is `completed` (or `crashed` when `is_error` says the last API call
 * failed); `error_max_turns`, `error_max_budget_usd` and `error_max_structured_output_retries`
 * are `failed`; anything else (`error_during_execution`) is `crashed`. A permission denial
 * overrides `completed` and `crashed` with `stopped_by_permission_denial` when it is what stopped
 * the run: `permission_denials` names the agent's last tool call (the agent was refused and then
 * ended its turn), or `terminal_reason` is `aborted_tools` with denials present. Denials the agent
 * worked around leave the outcome alone; they are still carried on the result.
 */
export function outcomeOf(
  result: ResultMessage,
  context: { lastToolCallId: string | undefined; timedOut: boolean },
): Outcome {
  const denied = new Set(result.permission_denials.map((denial) => denial.tool_use_id));
  const stoppedByDenial =
    denied.size > 0 &&
    ((context.lastToolCallId !== undefined && denied.has(context.lastToolCallId)) ||
      result.terminal_reason === 'aborted_tools');
  if (context.timedOut) return 'failed';
  switch (result.subtype) {
    case 'success':
      if (stoppedByDenial) return 'stopped_by_permission_denial';
      return result.is_error ? 'crashed' : 'completed';
    case 'error_max_turns':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return 'failed';
    default:
      return stoppedByDenial ? 'stopped_by_permission_denial' : 'crashed';
  }
}

/**
 * A stream message Placebo cannot read, or an `onEvent` callback that threw. Not an
 * infrastructure problem and not the agent's outcome: a bug to fix, so it propagates as is.
 */
export class StreamProtocolError extends Error {
  override readonly name = 'StreamProtocolError';
}

interface PendingTurn {
  readonly id: string;
  usage: MessageUsage;
  emitted: boolean;
}

/**
 * Stateful translation of one run's message stream. Feed every message to `push`, then call
 * `finish` once the stream ends (or `fail` if it threw).
 */
export class StreamTranslator {
  readonly #clock: Clock;
  readonly #emit: (event: RunnerEvent) => void;
  readonly #startedAt: Date;
  #init: { model: string; claudeCodeVersion: string } | undefined;
  #rawResult: ResultMessage | undefined;
  #usage: TokenUsage = ZERO_USAGE;
  /** Turns in order of first appearance, keyed by API message id. */
  readonly #turns = new Map<string, PendingTurn>();
  /** The message id each stream (main loop or subagent) is currently streaming. */
  readonly #streaming = new Map<string, string>();
  #lastToolCallId: string | undefined;
  #lastAssistantError: string | undefined;
  #lastRetryDelayMs: number | undefined;

  constructor(clock: Clock, emit: (event: RunnerEvent) => void) {
    this.#clock = clock;
    this.#emit = emit;
    this.#startedAt = clock.now();
  }

  /** True once `system_init` was emitted: from then on, a failure is the agent's outcome. */
  get started(): boolean {
    return this.#init !== undefined;
  }

  push(message: unknown): void {
    try {
      this.#route(message);
    } catch (error) {
      throw new StreamProtocolError(`cannot translate a Claude Code message: ${String(error)}`, {
        cause: error,
      });
    }
  }

  #route(message: unknown): void {
    const envelope = Envelope.safeParse(message);
    if (!envelope.success || this.#rawResult !== undefined) return;
    const { type, subtype } = envelope.data;
    if (type === 'system' && subtype === 'init') this.#onInit(SystemInit.parse(message));
    else if (!this.started) return;
    else if (type === 'system' && subtype === 'api_retry') {
      this.#lastRetryDelayMs = ApiRetry.parse(message).retry_delay_ms;
    } else if (type === 'assistant') this.#onAssistant(Assistant.parse(message));
    else if (type === 'user') this.#onUser(User.parse(message));
    else if (type === 'stream_event') this.#onStreamEvent(StreamEvent.parse(message));
    else if (type === 'result') this.#rawResult = ResultMessage.parse(message);
  }

  /**
   * Ends the run from its result message. Throws `RunnerInfraError` when the result says the
   * API was rate limited or unreachable; otherwise the result is the run's outcome.
   */
  finish(options: { timedOut: boolean }): RunnerResult {
    const raw = this.#rawResult;
    if (raw === undefined || this.#init === undefined) {
      throw new Error('finish() called without a system init and a result message');
    }
    this.#flushUsage();
    if (!options.timedOut && (raw.is_error || raw.subtype === 'error_during_execution')) {
      this.#throwIfInfra(raw);
    }
    const outcome = outcomeOf(raw, {
      lastToolCallId: this.#lastToolCallId,
      timedOut: options.timedOut,
    });
    return this.#end({
      outcome,
      costUsd: raw.total_cost_usd,
      turns: raw.num_turns,
      durationMs: raw.duration_ms,
      apiDurationMs: raw.duration_api_ms,
      stopReason: raw.stop_reason,
      permissionDenials: raw.permission_denials.map((denial) => ({
        tool: denial.tool_name,
        toolCallId: denial.tool_use_id,
        input: denial.tool_input,
      })),
      ...(raw.structured_output === undefined ? {} : { structuredOutput: raw.structured_output }),
    });
  }

  /** Whether a result message arrived. */
  get hasResult(): boolean {
    return this.#rawResult !== undefined;
  }

  /**
   * Ends a started run that stopped without a result message: the process died, or the time
   * limit aborted it. Costs and API time are unknown and recorded as zero.
   */
  synthesize(outcome: Outcome): RunnerResult {
    this.#flushUsage();
    return this.#end({
      outcome,
      costUsd: 0,
      turns: this.#turns.size,
      durationMs: Math.max(0, this.#clock.now().getTime() - this.#startedAt.getTime()),
      apiDurationMs: 0,
      stopReason: null,
      permissionDenials: [],
    });
  }

  /** A hint for `retryAfterMs` from Claude Code's own last API retry. */
  get lastRetryDelayMs(): number | undefined {
    return this.#lastRetryDelayMs;
  }

  #end(fields: Omit<ResultEvent, 'type' | 'timestamp'>): RunnerResult {
    const init = this.#init;
    if (init === undefined) throw new Error('a run cannot end before system init');
    const result: ResultEvent = { type: 'result', timestamp: this.#now(), ...fields };
    this.#emit(result);
    return {
      result,
      usage: this.#usage,
      model: init.model,
      claudeCodeVersion: init.claudeCodeVersion,
    };
  }

  #throwIfInfra(raw: ResultMessage): void {
    const text = [raw.result ?? '', ...(raw.errors ?? [])].join(' ').trim();
    const retry =
      this.#lastRetryDelayMs === undefined ? {} : { retryAfterMs: this.#lastRetryDelayMs };
    if (this.#lastAssistantError !== undefined && RATE_LIMIT_ERRORS.has(this.#lastAssistantError)) {
      throw new RunnerInfraError('rate_limited', text || this.#lastAssistantError, retry);
    }
    const infra = infraErrorFrom(text, { status: raw.api_error_status ?? null, ...retry });
    if (infra !== undefined) throw infra;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }

  #onInit(init: ReturnType<typeof SystemInit.parse>): void {
    if (this.#init !== undefined) return;
    this.#init = { model: init.model, claudeCodeVersion: init.claude_code_version };
    this.#emit({
      type: 'system_init',
      timestamp: this.#now(),
      model: init.model,
      claudeCodeVersion: init.claude_code_version,
      tools: init.tools,
    });
  }

  #onAssistant(message: Assistant): void {
    const { id, content, usage } = message.message;
    if (message.error !== undefined) this.#lastAssistantError = message.error;
    const turn = this.#turns.get(id);
    if (turn === undefined) this.#turns.set(id, { id, usage, emitted: false });
    else if (!turn.emitted) turn.usage = usage;
    for (const block of content) {
      const text = TextBlock.safeParse(block);
      if (text.success) {
        this.#emit({ type: 'assistant_text', timestamp: this.#now(), text: text.data.text });
        continue;
      }
      const toolUse = ToolUseBlock.safeParse(block);
      if (toolUse.success) {
        const { id: callId, name, input } = toolUse.data;
        this.#lastToolCallId = callId;
        this.#emit({ type: 'tool_call', timestamp: this.#now(), id: callId, name, input });
      }
    }
  }

  #onUser(message: ReturnType<typeof User.parse>): void {
    const { content } = message.message;
    if (typeof content === 'string') return;
    for (const block of content) {
      const toolResult = ToolResultBlock.safeParse(block);
      if (!toolResult.success) continue;
      this.#emit({
        type: 'tool_result',
        timestamp: this.#now(),
        id: toolResult.data.tool_use_id,
        output: toolResultText(toolResult.data.content),
        isError: toolResult.data.is_error ?? false,
      });
    }
  }

  /**
   * Assistant messages carry provisional usage (one message per content block, output tokens
   * not yet counted). The final usage of a turn arrives on its `message_delta` stream event,
   * so the runners ask for partial messages and emit each turn's usage from there.
   */
  #onStreamEvent(message: ReturnType<typeof StreamEvent.parse>): void {
    const stream = message.parent_tool_use_id ?? '';
    const start = MessageStart.safeParse(message.event);
    if (start.success) {
      const { id, usage } = start.data.message;
      this.#streaming.set(stream, id);
      if (!this.#turns.has(id)) this.#turns.set(id, { id, usage, emitted: false });
      return;
    }
    const delta = MessageDelta.safeParse(message.event);
    const id = this.#streaming.get(stream);
    if (!delta.success || id === undefined) return;
    const turn = this.#turns.get(id);
    if (turn === undefined || turn.emitted) return;
    const final = delta.data.usage;
    turn.usage = {
      input_tokens: final.input_tokens ?? turn.usage.input_tokens,
      output_tokens: final.output_tokens ?? turn.usage.output_tokens,
      cache_read_input_tokens: final.cache_read_input_tokens ?? turn.usage.cache_read_input_tokens,
      cache_creation_input_tokens:
        final.cache_creation_input_tokens ?? turn.usage.cache_creation_input_tokens,
    };
    this.#emitUsage(turn);
  }

  /**
   * Emits usage for turns that never received a `message_delta`, from their last message. Only
   * at the end: Claude Code runs tools while a turn still streams, so tool results routinely
   * arrive before the turn's `message_delta`.
   */
  #flushUsage(): void {
    for (const turn of this.#turns.values()) if (!turn.emitted) this.#emitUsage(turn);
  }

  #emitUsage(turn: PendingTurn): void {
    turn.emitted = true;
    const usage = tokenUsage(turn.usage);
    this.#usage = {
      input: this.#usage.input + usage.input,
      output: this.#usage.output + usage.output,
      cacheRead: this.#usage.cacheRead + usage.cacheRead,
      cacheWrite: this.#usage.cacheWrite + usage.cacheWrite,
    };
    this.#emit({ type: 'usage', timestamp: this.#now(), ...usage });
  }
}
