import type { Change } from './change.js';
import type { Outcome, ResultEvent, RunnerEvent, TokenUsage } from './events.js';
import type { Measurements } from './measurements.js';

/**
 * Tools counted as search calls (exploration effort): `Grep`, `Glob` and `WebSearch`. `Read` is
 * not a search; it is measured by `filesRead` and `bytesRead`.
 */
export const SEARCH_TOOLS: readonly string[] = ['Grep', 'Glob', 'WebSearch'];

const encoder = new TextEncoder();

/** The last `result` event, if the stream has one. */
function resultOf(events: readonly RunnerEvent[]): ResultEvent | undefined {
  return events.findLast((event): event is ResultEvent => event.type === 'result');
}

/** How the run ended; a stream with no `result` event is treated as crashed. */
export function deriveOutcome(events: readonly RunnerEvent[]): Outcome {
  return resultOf(events)?.outcome ?? 'crashed';
}

/**
 * What is measured per run (brief §8), derived from the event stream and the change. Pure.
 *
 * - `tokens` is the sum of every `usage` event (one per assistant turn).
 * - `costUsd`, `turns`, `durationMs`, `apiDurationMs` come from the `result` event; a stream with
 *   no `result` (a crashed run) reports zeros for them.
 * - `toolCalls` counts `tool_call` events, in total and by tool name.
 * - `filesRead` is the number of distinct `file_path` inputs of `Read` calls.
 * - `bytesRead` is the total UTF-8 length of the non-error `tool_result` outputs of `Read` calls.
 *   An approximation: Claude Code returns file content with line numbers and may truncate long
 *   files, so it is the bytes the agent saw, not the size of the files on disk.
 * - `searchCalls` counts calls to `SEARCH_TOOLS`.
 * - `changeBytes` and `filesTouched` come from the change.
 */
export function deriveMeasurements(events: readonly RunnerEvent[], change: Change): Measurements {
  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byTool: Record<string, number> = {};
  const readCallIds = new Set<string>();
  const filesRead = new Set<string>();
  let total = 0;
  let searchCalls = 0;
  let bytesRead = 0;

  for (const event of events) {
    if (event.type === 'usage') {
      tokens.input += event.input;
      tokens.output += event.output;
      tokens.cacheRead += event.cacheRead;
      tokens.cacheWrite += event.cacheWrite;
    } else if (event.type === 'tool_call') {
      total += 1;
      byTool[event.name] = (byTool[event.name] ?? 0) + 1;
      if (SEARCH_TOOLS.includes(event.name)) searchCalls += 1;
      if (event.name === 'Read') {
        readCallIds.add(event.id);
        const path = filePathOf(event.input);
        if (path !== undefined) filesRead.add(path);
      }
    } else if (event.type === 'tool_result' && !event.isError && readCallIds.has(event.id)) {
      bytesRead += encoder.encode(event.output).length;
    }
  }

  const result = resultOf(events);
  return {
    tokens,
    costUsd: result?.costUsd ?? 0,
    turns: result?.turns ?? 0,
    durationMs: result?.durationMs ?? 0,
    apiDurationMs: result?.apiDurationMs ?? 0,
    toolCalls: { total, byTool },
    filesRead: filesRead.size,
    bytesRead,
    searchCalls,
    changeBytes: change.bytes,
    filesTouched: change.files.length,
  };
}

function filePathOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const path = (input as { file_path?: unknown }).file_path;
  return typeof path === 'string' ? path : undefined;
}
