import type { RunnerEvent } from '../domain/events.js';

/**
 * The transcript a `regex` grader with `on: transcript` matches against: in event order, one
 * line per `assistant_text` event (its text) and per `tool_call` event (the tool name, a space,
 * and the JSON of its input). Tool results (file contents, command output) are not part of it,
 * so a pattern matches what the agent said and did, not what it read.
 */
export function transcriptOf(events: readonly RunnerEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === 'assistant_text') lines.push(event.text);
    else if (event.type === 'tool_call') {
      lines.push(`${event.name} ${JSON.stringify(event.input ?? null)}`);
    }
  }
  return lines.join('\n');
}
