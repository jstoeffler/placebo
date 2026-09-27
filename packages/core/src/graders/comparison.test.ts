import { afterEach, describe, expect, it } from 'vitest';
import { FakeRunner, type FakePlan } from '../adapters/fake-runner/fake-runner.js';
import { COMPARISON_JUDGE_OUTPUT_SCHEMA, Grade } from '../domain/grade.js';
import { Run } from '../domain/run.js';
import { ArmName } from '../domain/arm.js';
import { createSeededRandom } from '../kernel/random.js';
import { RunnerInfraError, type RunRequest } from '../ports/runner.js';
import { sampleRun } from '../testing/fixtures.js';
import { fixedClock, task, TempDirs } from '../testing/grading.js';
import { gradeComparisons, type ComparisonInput } from './comparison.js';
import { COMPARISON_SYSTEM_PROMPT } from './judge-prompts.js';

const dirs = new TempDirs();
afterEach(async () => {
  await dirs.cleanup();
});

const TREATMENT = {
  kind: 'treatment',
  variant: 'always-green',
  patch: 'variants/always-green.patch',
};
const OTHER = { kind: 'treatment', variant: 'other', patch: 'variants/other.patch' };

function run(id: string, arm: unknown, marker: string, taskId = 'refund-rounding'): Run {
  return Run.parse({
    ...sampleRun,
    id,
    taskId,
    arm,
    runFolder: `/tmp/placebo/${id}`,
    change: { diff: `+ change ${marker}\n`, files: ['src/money.ts'], bytes: 10 },
  });
}

const runs = [
  run('c1', { kind: 'control' }, 'C1'),
  run('c2', { kind: 'control' }, 'C2'),
  run('t1', TREATMENT, 'T1'),
  run('t2', TREATMENT, 'T2'),
  run('t3', TREATMENT, 'T3'),
  run('o1', OTHER, 'O1'),
  run('x1', { kind: 'control' }, 'X1', 'other-task'),
  run('x2', TREATMENT, 'X2', 'other-task'),
];

const comparisonTask = (grader: Record<string, unknown> = {}) =>
  task({
    graders: [
      { type: 'tool_used', tool: 'Read' },
      { type: 'comparison', ...grader },
    ],
  });

function input(
  plan: (request: RunRequest) => FakePlan,
  over: Partial<ComparisonInput> = {},
): { input: ComparisonInput; runner: FakeRunner } {
  const runner = new FakeRunner({ clock: fixedClock, plan });
  return {
    runner,
    input: {
      runs,
      task: comparisonTask(),
      treatment: ArmName.parse('always-green'),
      runner,
      judgeModel: 'claude-opus-5-5',
      createEmptyDir: () => dirs.create('placebo-judge-'),
      random: createSeededRandom(7),
      ...over,
    },
  };
}

const pick = (better: 'a' | 'b', reason = `${better} is better.`): FakePlan =>
  FakeRunner.plans.judgeAnswer({ better, reason });

/** The marker of the change shown as `slot` in a comparison prompt. */
function shown(prompt: string, slot: 'a' | 'b'): string | undefined {
  return new RegExp(`## Attempt ${slot}\\n\\n\`\`\`diff\\n\\+ change (\\w+)`).exec(prompt)?.[1];
}

describe('gradeComparisons', () => {
  it('pairs every treatment run of the task with a control run and stores the grade on it', async () => {
    const { input: i, runner } = input(() => pick('a'));
    const grades = await gradeComparisons(i);

    expect(grades.map((g) => g.runId)).toEqual(['t1', 't2', 't3']);
    expect(runner.requests).toHaveLength(3);
    for (const [n, { runId, grade }] of grades.entries()) {
      expect(Grade.parse(grade)).toEqual(grade);
      expect(grade.grader).toEqual({ type: 'comparison', index: 1 });
      expect(grade.kind).toBe('judge');
      expect(grade).not.toHaveProperty('passed');
      if (grade.detail.type !== 'comparison') throw new Error('expected a comparison detail');
      const { opponentRunId, position, preferred } = grade.detail;
      expect(['c1', 'c2']).toContain(opponentRunId);
      const prompt = runner.requests[n]!.prompt;
      const own = runId.toUpperCase();
      const opponent = opponentRunId.toUpperCase();
      expect(shown(prompt, position)).toBe(own);
      expect(shown(prompt, position === 'a' ? 'b' : 'a')).toBe(opponent);
      expect(preferred).toBe(position === 'a');
      expect(grade.score).toBe(position === 'a' ? 1 : 0);
      expect(grade.detail).toMatchObject({
        reason: 'a is better.',
        model: 'claude-opus-5-5',
        raw: [{ better: 'a', reason: 'a is better.' }],
      });
    }
  });

  it('is reproducible from the seed and puts the treatment in both positions across seeds', async () => {
    const positions = new Set<string>();
    const opponents = new Set<string>();
    for (let seed = 0; seed < 10; seed++) {
      const first = await gradeComparisons(
        input(() => pick('b'), { random: createSeededRandom(seed) }).input,
      );
      const second = await gradeComparisons(
        input(() => pick('b'), { random: createSeededRandom(seed) }).input,
      );
      expect(second).toEqual(first);
      for (const { grade } of first) {
        if (grade.detail.type === 'comparison') {
          positions.add(grade.detail.position);
          opponents.add(grade.detail.opponentRunId);
        }
      }
    }
    expect([...positions].sort()).toEqual(['a', 'b']);
    expect([...opponents].sort()).toEqual(['c1', 'c2']);
  });

  it('asks a blinded, one-turn, tool-less judge in an empty directory', async () => {
    const { input: i, runner } = input(() => pick('a'), {
      task: comparisonTask({ agentic: true }),
    });
    await gradeComparisons(i);
    for (const request of runner.requests) {
      expect(request).toMatchObject({
        tools: 'none',
        maxTurns: 1,
        settingSources: [],
        sandbox: false,
        strictMcpConfig: true,
        limits: {},
        model: 'claude-opus-5-5',
        systemPrompt: COMPARISON_SYSTEM_PROMPT,
        outputSchema: COMPARISON_JUDGE_OUTPUT_SCHEMA,
      });
      expect(request.cwd).not.toContain('/tmp/placebo/');
      const everything = `${request.prompt}\n${request.systemPrompt ?? ''}`.toLowerCase();
      for (const word of [
        'control',
        'treatment',
        'always-green',
        'variant',
        '/tmp/placebo',
        'run-1',
      ]) {
        expect(everything).not.toContain(word);
      }
      expect(request.prompt).toContain('Fix the rounding.');
    }
  });

  it('averages repeats with one position per pairing', async () => {
    const { input: i, runner } = input(
      () => (runner.requests.length % 2 === 1 ? pick('a', 'first') : pick('b', 'second')),
      { task: comparisonTask({ repeats: 2 }), runs: runs.slice(0, 3) },
    );
    const [only] = await gradeComparisons(i);
    expect(runner.requests).toHaveLength(2);
    expect(runner.requests[0]!.prompt).toBe(runner.requests[1]!.prompt);
    expect(only?.grade.score).toBe(0.5);
    expect(only?.grade.detail).toMatchObject({
      preferred: false,
      reason: '1: first\n2: second',
      raw: [
        { better: 'a', reason: 'first' },
        { better: 'b', reason: 'second' },
      ],
    });
  });

  it('gives an error grade when the task has no control run', async () => {
    const { input: i, runner } = input(() => pick('a'), {
      runs: runs.filter((r) => r.arm.kind !== 'control'),
    });
    expect(await gradeComparisons(i)).toEqual(
      ['t1', 't2', 't3'].map((runId) => ({
        runId,
        grade: {
          grader: { type: 'comparison', index: 1 },
          kind: 'judge',
          score: 0,
          detail: { type: 'error', message: 'no control run of this task to compare with' },
        },
      })),
    );
    expect(runner.requests).toHaveLength(0);
  });

  it('gives an error grade for an invalid answer, naming the repeat', async () => {
    const { input: i, runner } = input(
      () =>
        runner.requests.length === 1
          ? pick('a')
          : FakeRunner.plans.judgeAnswer({ better: 'tie', reason: '' }),
      { task: comparisonTask({ repeats: 2 }), runs: runs.slice(0, 3) },
    );
    const [only] = await gradeComparisons(i);
    expect(only?.grade.detail).toEqual({
      type: 'error',
      message:
        'judge answer is invalid: better: Invalid option: expected one of "a"|"b" (repeat 2 of 2)',
    });
  });

  it('gives an error grade for an invalid answer without repeats', async () => {
    const { input: i } = input(() => ({}), { runs: runs.slice(0, 3) });
    const [only] = await gradeComparisons(i);
    expect(only?.grade.detail).toEqual({
      type: 'error',
      message: 'judge returned no structured output',
    });
  });

  it('does nothing for a task without comparison graders', async () => {
    const { input: i } = input(() => pick('a'), {
      task: task({ graders: [{ type: 'tool_used', tool: 'Read' }] }),
    });
    expect(await gradeComparisons(i)).toEqual([]);
  });

  it('lets RunnerInfraError propagate', async () => {
    const error = new RunnerInfraError('network', 'offline');
    const { input: i } = input(() => ({ infraError: error }));
    await expect(gradeComparisons(i)).rejects.toBe(error);
  });
});
