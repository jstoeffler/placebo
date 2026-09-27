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
  z.strictObject({ type: z.literal('assistant_text'), timestamp: Timestamp, text: z.string() }),
  z.strictObject({
    type: z.literal('tool_call'),
    timestamp: Timestamp,
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    timestamp: Timestamp,
    /** The `id` of the matching `tool_call`. */
    id: z.string(),
    output: z.string(),
    isError: z.boolean(),
  }),
  /** Usage of one assistant turn. */
  z.strictObject({ type: z.literal('usage'), timestamp: Timestamp, ...TokenUsage.shape }),
  /** Always the last event of a run. */
  z.strictObject({
    type: z.literal('result'),
    timestamp: Timestamp,
    outcome: Outcome,
    costUsd: z.number().nonnegative(),
    turns: z.int().nonnegative(),
    durationMs: z.number().nonnegative(),
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
