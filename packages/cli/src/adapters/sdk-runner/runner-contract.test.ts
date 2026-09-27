import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Outcome,
  type Runner,
  RunnerEvent,
  RunnerInfraError,
  type TokenUsage,
} from '@placebo-eval/core';
import { describe, expect, it } from 'vitest';
import { CliRunner, type SpawnFunction } from '../cli-runner/cli-runner.js';
import { SdkRunner } from './sdk-runner.js';
import {
  type ContractScenario,
  contractMessages,
  fakeQuery,
  steppingClock,
  SUBJECT_REQUEST,
  toNdjson,
} from './test-support.js';

interface Harness {
  readonly runner: Runner;
  /** How many times the runner started Claude Code. */
  readonly calls: () => number;
}

const REQUEST = { ...SUBJECT_REQUEST, cwd: tmpdir() };

const OUTCOMES: readonly [Exclude<ContractScenario, 'spawn_failure'>, Outcome][] = [
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['crashed', 'crashed'],
  ['denied', 'stopped_by_permission_denial'],
];

/** Every clause of the `Runner` port's contract, for any runner. */
function runnerContractTests(
  name: string,
  makeRunner: (scenario: ContractScenario) => Harness,
): void {
  describe(`${name} honours the Runner contract`, () => {
    async function run(scenario: ContractScenario) {
      const harness = makeRunner(scenario);
      const events: RunnerEvent[] = [];
      const result = await harness.runner.run(REQUEST, (event) => events.push(event));
      return { harness, events, result };
    }

    it('emits system_init first and result last, every event in the normalized schema', async () => {
      const { events } = await run('completed');
      expect(events[0]?.type).toBe('system_init');
      expect(events.at(-1)?.type).toBe('result');
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      for (const event of events) expect(RunnerEvent.parse(event)).toEqual(event);
    });

    it('resolves with the last result event, the summed usage and the model', async () => {
      const { events, result } = await run('completed');
      expect(result.result).toEqual(events.at(-1));
      const summed = events.reduce<TokenUsage>(
        (sum, event) =>
          event.type === 'usage'
            ? {
                input: sum.input + event.input,
                output: sum.output + event.output,
                cacheRead: sum.cacheRead + event.cacheRead,
                cacheWrite: sum.cacheWrite + event.cacheWrite,
              }
            : sum,
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      );
      expect(result.usage).toEqual(summed);
      expect(result.model).toBe('claude-haiku-4-5-20251001');
      expect(result.claudeCodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it.each(OUTCOMES)('maps the %s scenario to the %s outcome', async (scenario, outcome) => {
      const { result } = await run(scenario);
      expect(result.result.outcome).toBe(outcome);
    });

    it('reports its Claude Code version as x.y.z', async () => {
      await expect(makeRunner('completed').runner.claudeCodeVersion()).resolves.toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    });

    it('throws a spawn_failed RunnerInfraError when Claude Code cannot start, and never retries', async () => {
      const harness = makeRunner('spawn_failure');
      const failure = harness.runner.run(REQUEST, () => undefined);
      await expect(failure).rejects.toBeInstanceOf(RunnerInfraError);
      await expect(failure).rejects.toMatchObject({ reason: 'spawn_failed' });
      expect(harness.calls()).toBe(1);
    });
  });
}

runnerContractTests('SdkRunner', (scenario) => {
  const fake =
    scenario === 'spawn_failure'
      ? fakeQuery([], {
          thenThrow: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
        })
      : fakeQuery(contractMessages(scenario, 'sdk'));
  return {
    runner: new SdkRunner({ query: fake.query, clock: steppingClock() }),
    calls: () => fake.calls.length,
  };
});

const FAKE_CLAUDE = new URL('../cli-runner/fixtures/fake-claude.mjs', import.meta.url).pathname;

runnerContractTests('CliRunner', (scenario) => {
  const dir = mkdtempSync(join(tmpdir(), 'placebo-cli-contract-'));
  const stream = join(dir, 'stream.ndjson');
  if (scenario !== 'spawn_failure')
    writeFileSync(stream, toNdjson(contractMessages(scenario, 'cli')));
  let calls = 0;
  const countingSpawn = ((...args: Parameters<SpawnFunction>) => {
    calls += 1;
    return spawn(...args);
  }) as SpawnFunction;
  return {
    runner: new CliRunner({
      executable: scenario === 'spawn_failure' ? join(dir, 'no-such-claude') : FAKE_CLAUDE,
      spawn: countingSpawn,
      clock: steppingClock(),
      env: { ...process.env, FAKE_CLAUDE_STREAM: stream },
    }),
    calls: () => calls,
  };
});
