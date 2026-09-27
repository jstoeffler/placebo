import type { RunnerEvent } from '@placebo-eval/core/results';
import { OUTCOME_LABEL } from '../data/model.js';
import { formatCount, formatCurrency, formatDuration } from '../format.js';

type EventOf<T extends RunnerEvent['type']> = Extract<RunnerEvent, { type: T }>;

const SUMMARY_LIMIT = 120;

function truncate(text: string, limit = SUMMARY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined;
  const value: unknown = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** A one-line summary of a tool call's input: the file, command or pattern it acts on. */
function summarizeInput(name: string, input: unknown): string {
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = field(input, key);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  let summary: string | undefined;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      summary = first('file_path', 'notebook_path');
      break;
    case 'Bash':
      summary = first('command');
      break;
    case 'Grep': {
      const pattern = first('pattern');
      const path = first('path', 'glob');
      summary =
        pattern === undefined ? undefined : path === undefined ? pattern : `${pattern} in ${path}`;
      break;
    }
    case 'Glob':
      summary = first('pattern');
      break;
    case 'WebFetch':
      summary = first('url');
      break;
    case 'WebSearch':
      summary = first('query');
      break;
    case 'Task':
    case 'Agent':
      summary = first('description', 'prompt');
      break;
    default:
      summary = undefined;
  }
  if (summary !== undefined) return truncate(summary);
  if (typeof input === 'object' && input !== null) {
    const firstString = Object.entries(input).find(([, value]) => typeof value === 'string');
    if (firstString !== undefined) return truncate(`${firstString[0]}: ${String(firstString[1])}`);
  }
  return '';
}

function offset(timestamp: string, start: number): string {
  const ms = Date.parse(timestamp) - start;
  return Number.isNaN(ms) ? '' : `+${formatDuration(Math.max(0, ms))}`;
}

type Item =
  | { readonly kind: 'event'; readonly event: RunnerEvent }
  | {
      readonly kind: 'tool';
      readonly call: EventOf<'tool_call'>;
      readonly result: EventOf<'tool_result'> | undefined;
    };

/** Pairs each tool call with its result, keeping every other event in stream order. */
function timelineItems(events: readonly RunnerEvent[]): Item[] {
  const results = new Map<string, EventOf<'tool_result'>>();
  for (const event of events) if (event.type === 'tool_result') results.set(event.id, event);
  const callIds = new Set(
    events.flatMap((event) => (event.type === 'tool_call' ? [event.id] : [])),
  );
  const items: Item[] = [];
  for (const event of events) {
    if (event.type === 'tool_call') {
      items.push({ kind: 'tool', call: event, result: results.get(event.id) });
    } else if (event.type !== 'tool_result' || !callIds.has(event.id)) {
      items.push({ kind: 'event', event });
    }
  }
  return items;
}

export function Timeline({ events }: { readonly events: readonly RunnerEvent[] }) {
  const start = events[0] === undefined ? 0 : Date.parse(events[0].timestamp);
  const items = timelineItems(events);
  let turn = 0;
  return (
    <ol className="timeline">
      {items.map((item, i) => {
        const timestamp = item.kind === 'tool' ? item.call.timestamp : item.event.timestamp;
        if (item.kind === 'event' && item.event.type === 'usage') turn += 1;
        return (
          <li key={i} className={`step step-${item.kind === 'tool' ? 'tool' : item.event.type}`}>
            <span className="step-time">{offset(timestamp, start)}</span>
            <div className="step-body">
              {item.kind === 'tool' ? (
                <ToolStep call={item.call} result={item.result} />
              ) : (
                <EventStep event={item.event} turn={turn} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ToolStep({
  call,
  result,
}: {
  readonly call: EventOf<'tool_call'>;
  readonly result: EventOf<'tool_result'> | undefined;
}) {
  const summary = summarizeInput(call.name, call.input);
  return (
    <details className="tool">
      <summary>
        <span className="tool-name">{call.name}</span>
        {summary !== '' && <span className="tool-summary">{summary}</span>}
        {result?.isError === true && <span className="tag tag-error">error</span>}
      </summary>
      <div className="tool-detail">
        <h4>Input</h4>
        <pre>{JSON.stringify(call.input, null, 2)}</pre>
        <h4>{result?.isError === true ? 'Result (error)' : 'Result'}</h4>
        {result === undefined ? (
          <p className="quiet">No result was recorded for this call.</p>
        ) : result.output === '' ? (
          <p className="quiet">Empty output.</p>
        ) : (
          <pre>{result.output}</pre>
        )}
      </div>
    </details>
  );
}

function EventStep({ event, turn }: { readonly event: RunnerEvent; readonly turn: number }) {
  switch (event.type) {
    case 'system_init':
      return (
        <p className="step-meta">
          Started with {event.model}, Claude Code {event.claudeCodeVersion}, {event.tools.length}{' '}
          tools available.
        </p>
      );
    case 'assistant_text':
      return <p className="assistant">{event.text}</p>;
    case 'tool_call':
      return null;
    case 'tool_result':
      return (
        <div>
          <p className="step-meta">Result of an unknown call {event.id}</p>
          <pre>{event.output}</pre>
        </div>
      );
    case 'usage':
      return (
        <p className="step-meta usage">
          Turn {turn}: {formatCount(event.input)} in, {formatCount(event.output)} out,{' '}
          {formatCount(event.cacheRead)} cache read, {formatCount(event.cacheWrite)} cache write
        </p>
      );
    case 'result':
      return (
        <div className="step-result">
          <p>
            Ended {OUTCOME_LABEL[event.outcome]} after {event.turns} turns,{' '}
            {formatDuration(event.durationMs)}, {formatCurrency(event.costUsd)}
            {event.stopReason === null ? '.' : `; stop reason ${event.stopReason}.`}
          </p>
          {event.permissionDenials.length > 0 && (
            <ul className="denials">
              {event.permissionDenials.map((denial) => (
                <li key={denial.toolCallId}>
                  Permission denied for {denial.tool}
                  {summarizeInput(denial.tool, denial.input) === ''
                    ? ''
                    : `: ${summarizeInput(denial.tool, denial.input)}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
  }
}
