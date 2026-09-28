import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveMeasurements, type Runner, RunnerEvent } from '@placebo-eval/core';
import { describe, expect, it } from 'vitest';
import { CliRunner } from '../cli-runner/cli-runner.js';
import { SdkRunner } from './sdk-runner.js';
import {
  cliMessages,
  fakeQuery,
  isRemainder,
  modelUsageTotals,
  sdkMessages,
  steppingClock,
  SUBJECT_REQUEST,
  sumUsage,
  toNdjson,
  withoutLastResult,
} from './test-support.js';

// Subagent work, recorded from the real SDK and `claude -p` by `pnpm smoke --record
// --scenario=sync-subagent,background-subagent`: a synchronous `Agent` call, and a background
// one whose subagent keeps working after the parent's first result message.

type Message = Record<string, unknown>;

const REQUEST = { ...SUBJECT_REQUEST, cwd: tmpdir(), tools: 'subject' } as const;
const FAKE_CLAUDE = new URL('../cli-runner/fixtures/fake-claude.mjs', import.meta.url).pathname;
const NO_CHANGE = { diff: '', files: [], bytes: 0 };

const RUNNERS: readonly [string, (messages: readonly Message[]) => Runner][] = [
  [
    'SdkRunner',
    (messages) => new SdkRunner({ query: fakeQuery(messages).query, clock: steppingClock() }),
  ],
  [
    'CliRunner',
    (messages) => {
      const stream = join(mkdtempSync(join(tmpdir(), 'placebo-subagents-')), 'stream.ndjson');
      writeFileSync(stream, toNdjson(messages));
      return new CliRunner({
        executable: FAKE_CLAUDE,
        clock: steppingClock(),
        env: { ...process.env, FAKE_CLAUDE_STREAM: stream },
      });
    },
  ],
];

function recorded(runner: string, scenario: 'sync-subagent' | 'background-subagent'): Message[] {
  return runner === 'SdkRunner' ? sdkMessages(scenario) : cliMessages(scenario);
}

function resultsOf(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.type === 'result');
}

async function translate(runner: Runner) {
  const events: RunnerEvent[] = [];
  const result = await runner.run(REQUEST, (event) => events.push(event));
  return { events, result };
}

/** The id of the main loop's `Agent` call. */
function agentCallId(events: readonly RunnerEvent[]): string {
  const call = events.find(
    (event) =>
      event.type === 'tool_call' && event.name === 'Agent' && !('parentToolUseId' in event),
  );
  if (call?.type !== 'tool_call') throw new Error('no Agent call in the main loop');
  return call.id;
}

describe.each(RUNNERS)('%s with subagents', (name, makeRunner) => {
  describe.each(['sync-subagent', 'background-subagent'] as const)('%s', (scenario) => {
    const messages = recorded(name, scenario);
    const last = resultsOf(messages).at(-1);

    it('attributes every subagent event to the Agent call that started it', async () => {
      const { events } = await translate(makeRunner(messages));
      for (const event of events) expect(RunnerEvent.parse(event)).toEqual(event);
      const agent = agentCallId(events);
      const nested = events.filter((event) => 'parentToolUseId' in event);
      expect(
        new Set(nested.map((event) => 'parentToolUseId' in event && event.parentToolUseId)),
      ).toEqual(new Set([agent]));
      expect(nested.map((event) => event.type)).toEqual(
        expect.arrayContaining(['tool_call', 'tool_result', 'usage']),
      );
      expect(nested).toContainEqual(expect.objectContaining({ type: 'tool_call', name: 'Edit' }));
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('result');
    });

    it("sums usage to the last result's modelUsage and keeps its cost", async () => {
      const { events, result } = await translate(makeRunner(messages));
      expect(sumUsage(events)).toEqual(modelUsageTotals(last));
      expect(result.usage).toEqual(modelUsageTotals(last));
      expect(events.filter(isRemainder)).toHaveLength(1);
      expect(result.result).toMatchObject({
        costUsd: last?.total_cost_usd,
        reportedCostUsd: last?.total_cost_usd,
        costEstimated: false,
        apiDurationMs: last?.duration_api_ms,
      });
    });

    it('counts main-loop turns over every result and subagent turns from their usage', async () => {
      const { events, result } = await translate(makeRunner(messages));
      const results = resultsOf(messages);
      const turns = results.reduce((sum, message) => sum + Number(message.num_turns), 0);
      const reported = results.reduce((sum, message) => sum + Number(message.duration_ms), 0);
      expect(result.result.turns).toBe(turns);
      expect(result.result.reportedDurationMs).toBe(reported);
      const measurements = deriveMeasurements(events, NO_CHANGE);
      expect(measurements.turns).toBe(turns);
      expect(measurements.subagentTurns).toBeGreaterThanOrEqual(2);
      expect(measurements.toolCalls.byTool).toMatchObject({ Agent: 1, Edit: 1 });
    });
  });

  // `claude -p` holds its first result back until background work ends (docs/measurement.md);
  // the SDK yields it at once and keeps streaming.
  it.runIf(name === 'SdkRunner')(
    'reads the stream past the first result while a background subagent works',
    async () => {
      const messages = recorded(name, 'background-subagent');
      expect(resultsOf(messages)).toHaveLength(2);
      const { events } = await translate(makeRunner(messages));
      const agent = agentCallId(events);
      const edit = events.findIndex(
        (event) =>
          event.type === 'tool_call' && event.name === 'Edit' && event.parentToolUseId === agent,
      );
      // The parent's reply to the user, which came with its first result, precedes the edit.
      const launched = events.findIndex(
        (event) => event.type === 'assistant_text' && !('parentToolUseId' in event),
      );
      expect(edit).toBeGreaterThan(launched);
    },
  );

  it.runIf(name === 'SdkRunner')(
    'estimates the cost of usage streamed after the last result message',
    async () => {
      const full = recorded(name, 'background-subagent');
      const [first, second] = resultsOf(full);
      const { events, result } = await translate(makeRunner(withoutLastResult(full)));
      const reported = Number(first?.total_cost_usd);
      expect(result.result.reportedCostUsd).toBe(reported);
      expect(result.result.costEstimated).toBe(true);
      // Subagent turns stream provisional output tokens, so the estimate falls short of what
      // Claude Code later reported, but covers most of it.
      const later = Number(second?.total_cost_usd) - reported;
      const estimate = result.result.costUsd - reported;
      expect(estimate).toBeGreaterThan(later * 0.5);
      expect(estimate).toBeLessThanOrEqual(later);
      expect(sumUsage(events.filter((event) => !isRemainder(event))).cacheRead).toBeGreaterThan(
        modelUsageTotals(first).cacheRead,
      );
    },
  );
});
