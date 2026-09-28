// Test support for the runner adapters: recorded messages and a fake `query`. Imported only by
// tests; production code never imports it.
import { readFileSync } from 'node:fs';
import type { Clock, RunnerEvent, RunRequest, TokenUsage } from '@placebo-eval/core';
import type { QueryFunction } from './sdk-runner.js';

export type RecordedScenario =
  | 'subject'
  | 'judge'
  | 'read-only-judge'
  | 'max-turns'
  | 'timeout'
  | 'sync-subagent'
  | 'background-subagent';

type Message = Record<string, unknown>;

/** Messages recorded from the real SDK by `scripts/smoke-runner.ts`. */
export function sdkMessages(scenario: RecordedScenario): Message[] {
  const url = new URL(`fixtures/sdk-messages-${scenario}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Message[];
}

/** Lines recorded from the real `claude -p --output-format stream-json` by the smoke script. */
export function cliMessages(scenario: RecordedScenario): Message[] {
  const url = new URL(`../cli-runner/fixtures/cli-stream-${scenario}.ndjson`, import.meta.url);
  return readFileSync(url, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Message);
}

/** Messages as NDJSON, the way `claude -p` prints them. */
export function toNdjson(messages: readonly unknown[]): string {
  return messages.map((message) => `${JSON.stringify(message)}\n`).join('');
}

/** The recorded messages with the result message's fields replaced. */
export function withResult(messages: readonly Message[], fields: Message): Message[] {
  return messages.map((message) =>
    message.type === 'result' ? { ...message, ...fields } : message,
  );
}

/** The recorded messages without their result message, as when the process dies. */
export function withoutResult(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.type !== 'result');
}

/** The recorded messages up to, not including, the last result message and what follows it. */
export function withoutLastResult(messages: readonly Message[]): Message[] {
  const last = messages.findLastIndex((message) => message.type === 'result');
  return messages.slice(0, last);
}

export function isRemainder(event: RunnerEvent): boolean {
  return event.type === 'usage' && event.remainder === true;
}

/** The sum of the `usage` events among `events`. */
export function sumUsage(events: readonly RunnerEvent[]): TokenUsage {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const event of events) {
    if (event.type !== 'usage') continue;
    sum.input += event.input;
    sum.output += event.output;
    sum.cacheRead += event.cacheRead;
    sum.cacheWrite += event.cacheWrite;
  }
  return sum;
}

/** The main-loop `usage` of a recorded result message. */
export function mainLoopUsage(result: Message | undefined): TokenUsage {
  const usage = result?.usage as Record<string, number>;
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

/** The token totals over every model of a recorded result message's `modelUsage`. */
export function modelUsageTotals(result: Message | undefined): TokenUsage {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = result?.modelUsage as Record<string, Record<string, number>>;
  for (const entry of Object.values(models)) {
    sum.input += entry.inputTokens ?? 0;
    sum.output += entry.outputTokens ?? 0;
    sum.cacheRead += entry.cacheReadInputTokens ?? 0;
    sum.cacheWrite += entry.cacheCreationInputTokens ?? 0;
  }
  return sum;
}

/** The id of the last tool call in the recorded messages. */
function lastToolCallId(messages: readonly Message[]): string {
  const ids = messages.flatMap((message) => {
    if (message.type !== 'assistant') return [];
    const content = (message.message as { content: { type: string; id?: string }[] }).content;
    return content.flatMap((block) => (block.type === 'tool_use' && block.id ? [block.id] : []));
  });
  const last = ids.at(-1);
  if (last === undefined) throw new Error('no tool call in these messages');
  return last;
}

/** Each outcome, and a spawn failure, as a stream of recorded messages. */
export type ContractScenario = 'completed' | 'failed' | 'crashed' | 'denied' | 'spawn_failure';

export function contractMessages(
  scenario: Exclude<ContractScenario, 'spawn_failure'>,
  source: 'sdk' | 'cli',
): Message[] {
  const load = source === 'sdk' ? sdkMessages : cliMessages;
  const subject = load('subject');
  switch (scenario) {
    case 'completed':
      return subject;
    case 'failed':
      return load('max-turns');
    case 'crashed':
      return withResult(subject, {
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['Tool execution crashed'],
        stop_reason: null,
      });
    case 'denied': {
      const id = lastToolCallId(subject);
      return withResult(subject, {
        permission_denials: [{ tool_name: 'Edit', tool_use_id: id, tool_input: {} }],
      });
    }
  }
}

export interface FakeQuery {
  readonly query: QueryFunction;
  readonly calls: Parameters<QueryFunction>[0][];
}

/**
 * A fake `query` yielding the given messages, then throwing `thenThrow` if given. With
 * `hang`, it waits after the messages until the abort signal fires, then throws an AbortError
 * as the SDK does.
 */
export function fakeQuery(
  messages: readonly unknown[],
  options: { thenThrow?: Error; hang?: boolean } = {},
): FakeQuery {
  const calls: Parameters<QueryFunction>[0][] = [];
  const query: QueryFunction = (params) => {
    calls.push(params);
    return (async function* () {
      for (const message of messages) {
        await Promise.resolve();
        yield message;
      }
      const signal = params.options.abortController?.signal;
      if (options.hang === true && signal !== undefined) {
        await new Promise((resolve) => {
          signal.addEventListener('abort', resolve, { once: true });
        });
        const aborted = new Error('Claude Code process aborted by user');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (options.thenThrow !== undefined) throw options.thenThrow;
    })();
  };
  return { query, calls };
}

/** A clock that advances one second per reading, from a fixed start. */
export function steppingClock(start = '2026-09-27T12:00:00.000Z'): Clock {
  let time = new Date(start).getTime();
  return {
    now: () => {
      const now = new Date(time);
      time += 1000;
      return now;
    },
  };
}

export const SUBJECT_REQUEST: RunRequest = {
  cwd: '/tmp/placebo-smoke',
  prompt: 'Add a comment line at the top of hello.txt saying hi. Do nothing else.',
  model: 'claude-haiku-4-5-20251001',
  settingSources: ['project'],
  sandbox: true,
  strictMcpConfig: true,
  limits: {},
  tools: 'all',
};

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: { first_line_says_hi: { type: 'boolean' }, rest_unchanged: { type: 'boolean' } },
  required: ['first_line_says_hi', 'rest_unchanged'],
  additionalProperties: false,
} as const;

export const JUDGE_REQUEST: RunRequest = {
  cwd: '/tmp/placebo-judge',
  prompt: 'Answer both questions.',
  model: 'claude-haiku-4-5-20251001',
  settingSources: [],
  sandbox: false,
  strictMcpConfig: true,
  limits: {},
  tools: 'none',
  maxTurns: 1,
  outputSchema: JUDGE_SCHEMA,
  systemPrompt: 'You are a judge.',
};

export const READ_ONLY_JUDGE_REQUEST: RunRequest = {
  ...JUDGE_REQUEST,
  tools: 'read_only',
  maxTurns: 10,
};
