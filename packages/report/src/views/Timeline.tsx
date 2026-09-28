import type { RunnerEvent } from '@placebo-eval/core/results';
import { costLabel, OUTCOME_LABEL } from '../data/model.js';
import { formatDuration, formatTokens } from '@placebo-eval/core/format';

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

function parentOf(event: RunnerEvent): string | undefined {
  return 'parentToolUseId' in event ? event.parentToolUseId : undefined;
}

type Item =
  | { readonly kind: 'event'; readonly event: RunnerEvent }
  | {
      readonly kind: 'tool';
      readonly call: EventOf<'tool_call'>;
      readonly result: EventOf<'tool_result'> | undefined;
      /** Events of the subagent this call started, nested; empty for other tools. */
      readonly children: readonly Item[];
    };

/**
 * The events of one level of the tree, in stream order: the main loop's (`parent` undefined) or
 * one subagent's. Each tool call is paired with its result and carries the items of the
 * subagent it started, if any.
 */
function timelineItems(events: readonly RunnerEvent[], parent: string | undefined): Item[] {
  const results = new Map<string, EventOf<'tool_result'>>();
  for (const event of events) if (event.type === 'tool_result') results.set(event.id, event);
  const callIds = new Set(
    events.flatMap((event) => (event.type === 'tool_call' ? [event.id] : [])),
  );
  const items: Item[] = [];
  for (const event of events) {
    if (parentOf(event) !== parent) continue;
    if (event.type === 'tool_call') {
      const children = timelineItems(events, event.id);
      items.push({ kind: 'tool', call: event, result: results.get(event.id), children });
    } else if (event.type !== 'tool_result' || !callIds.has(event.id)) {
      items.push({ kind: 'event', event });
    }
  }
  return items;
}

/** Turns and tokens of a subagent, its own nested subagents included. */
function subagentSpend(items: readonly Item[]): { turns: number; tokens: number } {
  let turns = 0;
  let tokens = 0;
  for (const item of items) {
    if (item.kind === 'tool') {
      const nested = subagentSpend(item.children);
      turns += nested.turns;
      tokens += nested.tokens;
    } else if (item.event.type === 'usage' && item.event.remainder !== true) {
      turns += 1;
      tokens += item.event.input + item.event.output + item.event.cacheRead + item.event.cacheWrite;
    }
  }
  return { turns, tokens };
}

export function Timeline({ events }: { readonly events: readonly RunnerEvent[] }) {
  const start = events[0] === undefined ? 0 : Date.parse(events[0].timestamp);
  return <Steps items={timelineItems(events, undefined)} start={start} nested={false} />;
}

function Steps({
  items,
  start,
  nested,
}: {
  readonly items: readonly Item[];
  readonly start: number;
  readonly nested: boolean;
}) {
  let turn = 0;
  return (
    <ol className={nested ? 'timeline timeline-nested' : 'timeline'}>
      {items.map((item, i) => {
        const timestamp = item.kind === 'tool' ? item.call.timestamp : item.event.timestamp;
        if (item.kind === 'event' && item.event.type === 'usage' && item.event.remainder !== true)
          turn += 1;
        const kind =
          item.kind === 'tool'
            ? item.children.length > 0
              ? 'tool step-subagent'
              : 'tool'
            : item.event.type;
        return (
          <li key={i} className={`step step-${kind}`}>
            <span className="step-time">{offset(timestamp, start)}</span>
            <div className="step-body">
              {item.kind === 'tool' ? (
                <ToolStep item={item} start={start} />
              ) : (
                <EventStep event={item.event} turn={turn} nested={nested} />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ToolStep({
  item,
  start,
}: {
  readonly item: Extract<Item, { kind: 'tool' }>;
  readonly start: number;
}) {
  const { call, result, children } = item;
  const summary = summarizeInput(call.name, call.input);
  const spend = children.length > 0 ? subagentSpend(children) : undefined;
  return (
    <details className="tool">
      <summary>
        <span className="tool-name">{call.name}</span>
        {summary !== '' && <span className="tool-summary">{summary}</span>}
        {spend !== undefined && (
          <span className="tool-spend">
            subagent: {spend.turns} {spend.turns === 1 ? 'turn' : 'turns'},{' '}
            {formatTokens(spend.tokens)} tokens
          </span>
        )}
        {result?.isError === true && <span className="tag tag-error">error</span>}
      </summary>
      <div className="tool-detail">
        <h4>Input</h4>
        <pre>{JSON.stringify(call.input, null, 2)}</pre>
        {children.length > 0 && (
          <>
            <h4>Subagent</h4>
            <Steps items={children} start={start} nested={true} />
          </>
        )}
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

function EventStep({
  event,
  turn,
  nested,
}: {
  readonly event: RunnerEvent;
  readonly turn: number;
  readonly nested: boolean;
}) {
  switch (event.type) {
    case 'system_init':
      return (
        <div>
          <p className="step-meta">
            Started with {event.model}, Claude Code {event.claudeCodeVersion}, {event.tools.length}{' '}
            tools available.
          </p>
          {event.tools.length > 0 && (
            <p className="step-meta tools-available">{event.tools.join(', ')}</p>
          )}
        </div>
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
    case 'usage': {
      const counts = `${formatTokens(event.input)} in, ${formatTokens(event.output)} out, ${formatTokens(event.cacheRead)} cache read, ${formatTokens(event.cacheWrite)} cache write`;
      return (
        <p className="step-meta usage">
          {event.remainder === true
            ? `Counted by Claude Code outside the streamed turns (subagents' final output, helper calls): ${counts}`
            : `${nested ? 'Subagent turn' : 'Turn'} ${String(turn)}: ${counts}`}
        </p>
      );
    }
    case 'result':
      return (
        <div className="step-result">
          <p>
            Ended {OUTCOME_LABEL[event.outcome]} after {event.turns} turns,{' '}
            {formatDuration(event.durationMs)}, {costLabel(event.costUsd, event.costEstimated)}
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
