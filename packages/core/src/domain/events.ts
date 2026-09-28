import { z } from 'zod';

/** How a run ended. */
export const Outcome = z.enum(['completed', 'failed', 'crashed', 'stopped_by_permission_denial']);
export type Outcome = z.infer<typeof Outcome>;

/** Token counts, reported separately because cache skews cost. */
export const TokenUsage = z.strictObject({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cacheRead: z.int().nonnegative(),
  cacheWrite: z.int().nonnegative(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/** A tool call the permission system refused. */
export const PermissionDenial = z.strictObject({
  tool: z.string(),
  toolCallId: z.string(),
  input: z.unknown(),
});
export type PermissionDenial = z.infer<typeof PermissionDenial>;

const Timestamp = z.iso.datetime();

/**
 * The `id` of the `Agent` tool call whose subagent produced the event; absent for the main loop.
 * Nested subagents point at the call that started them, so events form a tree.
 */
const ParentToolUseId = z.string().optional();

/**
 * The normalized, runner-agnostic event stream. The SDK runner, the installed-CLI runner and
 * the fake runner all emit exactly these shapes, so graders, measurements and the transcript
 * viewer never know which runner produced a run.
 */
export const RunnerEvent = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('system_init'),
    timestamp: Timestamp,
    /** Full model ID actually used. */
    model: z.string(),
    claudeCodeVersion: z.string(),
    /** Tool names available to the agent. */
    tools: z.array(z.string()),
  }),
  z.strictObject({
    type: z.literal('assistant_text'),
    timestamp: Timestamp,
    text: z.string(),
    parentToolUseId: ParentToolUseId,
  }),
  z.strictObject({
    type: z.literal('tool_call'),
    timestamp: Timestamp,
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolUseId: ParentToolUseId,
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    timestamp: Timestamp,
    /** The `id` of the matching `tool_call`. */
    id: z.string(),
    output: z.string(),
    isError: z.boolean(),
    parentToolUseId: ParentToolUseId,
  }),
  /** Usage of one assistant turn, or, with `remainder`, of no turn in particular. */
  z.strictObject({
    type: z.literal('usage'),
    timestamp: Timestamp,
    ...TokenUsage.shape,
    parentToolUseId: ParentToolUseId,
    /**
     * Tokens Claude Code's own per-model totals count beyond the streamed turns: the final
     * output tokens of subagent turns, which the stream reports only provisionally, and Claude
     * Code's helper calls. Not a turn. At most one per run.
     */
    remainder: z.literal(true).optional(),
  }),
  /** Always the last event of a run. */
  z.strictObject({
    type: z.literal('result'),
    timestamp: Timestamp,
    outcome: Outcome,
    /** Total cost: `reportedCostUsd` plus, when `costEstimated`, an estimate for later usage. */
    costUsd: z.number().nonnegative(),
    /** The cost Claude Code reported in its last result message. */
    reportedCostUsd: z.number().nonnegative().optional(),
    /** True when part of `costUsd` is estimated: usage streamed after the last result message. */
    costEstimated: z.boolean().optional(),
    /** Turns of the main loop; subagent turns are counted from `usage` events. */
    turns: z.int().nonnegative(),
    /** Wall clock, from starting Claude Code to its exit. */
    durationMs: z.number().nonnegative(),
    /** The duration Claude Code reported: the sum of its result messages' own durations. */
    reportedDurationMs: z.number().nonnegative().optional(),
    apiDurationMs: z.number().nonnegative(),
    stopReason: z.string().nullable(),
    permissionDenials: z.array(PermissionDenial),
    /** The schema-enforced answer, for judge queries (ADR 0007). */
    structuredOutput: z.unknown().optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof RunnerEvent>;
export type RunnerEventType = RunnerEvent['type'];
export type RunnerEventOf<T extends RunnerEventType> = Extract<RunnerEvent, { type: T }>;
export type ResultEvent = RunnerEventOf<'result'>;
