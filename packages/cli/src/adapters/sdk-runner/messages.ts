import { z } from 'zod';

// The subset of Claude Code's stream messages that runners read. The Agent SDK yields these
// objects and `claude -p --output-format stream-json` prints the same objects as NDJSON, so both
// runners parse them here, at the edge. Objects are loose: Claude Code adds fields often.

const count = z.number().int().nonnegative();
const optionalCount = count.nullish().transform((value) => value ?? 0);

/** Usage as the Messages API reports it; cache fields may be absent or null. */
export const MessageUsage = z.looseObject({
  input_tokens: optionalCount,
  output_tokens: optionalCount,
  cache_read_input_tokens: optionalCount,
  cache_creation_input_tokens: optionalCount,
});
export type MessageUsage = z.infer<typeof MessageUsage>;

/** Usage on a `message_delta` stream event: every field is final when present. */
const DeltaUsage = z.looseObject({
  input_tokens: count.nullish(),
  output_tokens: count.nullish(),
  cache_read_input_tokens: count.nullish(),
  cache_creation_input_tokens: count.nullish(),
});

export const SystemInit = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  model: z.string(),
  claude_code_version: z.string(),
  tools: z.array(z.string()),
});

export const ApiRetry = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('api_retry'),
  retry_delay_ms: z.number().nonnegative(),
  error_status: z.number().nullable(),
  error: z.string(),
});

export const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
export const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().nullish(),
});
/** Thinking, images, server tools and future block types carry nothing a runner reports. */
const ContentBlock = z.looseObject({ type: z.string() });

export const Assistant = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({
    id: z.string(),
    content: z.array(ContentBlock),
    usage: MessageUsage,
  }),
  parent_tool_use_id: z.string().nullish(),
  /** Set on the synthetic message Claude Code writes when an API request failed. */
  error: z.string().optional(),
});
export type Assistant = z.infer<typeof Assistant>;

export const User = z.looseObject({
  type: z.literal('user'),
  message: z.looseObject({ content: z.union([z.string(), z.array(ContentBlock)]) }),
});

export const StreamEvent = z.looseObject({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullish(),
  event: z.looseObject({ type: z.string() }),
});

export const ResultMessage = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().nonnegative(),
  duration_api_ms: z.number().nonnegative(),
  num_turns: count,
  total_cost_usd: z.number().nonnegative(),
  stop_reason: z.string().nullable(),
  terminal_reason: z.string().nullish(),
  api_error_status: z.number().nullish(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  permission_denials: z.array(
    z.looseObject({ tool_name: z.string(), tool_use_id: z.string(), tool_input: z.unknown() }),
  ),
  structured_output: z.unknown().optional(),
});
export type ResultMessage = z.infer<typeof ResultMessage>;

export const MessageStart = z.looseObject({
  type: z.literal('message_start'),
  message: z.looseObject({ id: z.string(), usage: MessageUsage }),
});
export const MessageDelta = z.looseObject({ type: z.literal('message_delta'), usage: DeltaUsage });

/** Just enough to route a message to its schema. */
export const Envelope = z.looseObject({ type: z.string(), subtype: z.string().optional() });
