import { existsSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner, type FakePlan } from '../adapters/fake-runner/fake-runner.js';
import { TreatmentArm } from '../domain/arm.js';
import { RunnerEvent } from '../domain/events.js';
import { CHECKLIST_JUDGE_OUTPUT_SCHEMA, Grade } from '../domain/grade.js';
import { RunnerInfraError, type RunRequest } from '../ports/runner.js';
import { sampleEvents } from '../testing/fixtures.js';
import {
  gradingContext,
  stubExecutor,
  task,
  TempDirs,
  type ContextOptions,
} from '../testing/grading.js';
import { gradeRun } from './grade-run.js';
import { CHECKLIST_SYSTEM_PROMPT } from './judge-prompts.js';

const dirs = new TempDirs();
let runFolder: string;
beforeEach(async () => {
  runFolder = await dirs.create('placebo-run-');
});
afterEach(async () => {
  await dirs.cleanup();
});

const DIFF = [
  'diff --git a/src/money.ts b/src/money.ts',
  '--- a/src/money.ts',
  '+++ b/src/money.ts',
  '@@ -1 +1 @@',
  '-  return Math.floor(amount * 100) / 100;',
  '+  return Math.round(amount * 100) / 100;',
  '',
].join('\n');

const QUESTIONS_PATH = 'tasks/refund-rounding/checklist.md';
const QUESTIONS = [
  '# Checklist',
  '',
  '- Does it round half up?',
  '1. Does `refund` keep its signature?',
  'Some prose that is not a question.',
  '',
].join('\n');

const arm = TreatmentArm.parse({
  kind: 'treatment',
  variant: 'always-green',
  patch: 'variants/always-green.patch',
});

function setup(
  graders: readonly Record<string, unknown>[],
  over: Partial<ContextOptions> = {},
): ReturnType<typeof gradingContext> {
  const built = gradingContext({
    task: task({ graders }),
    runFolder,
    dirs,
    diff: DIFF,
    changedFiles: ['src/money.ts'],
    events: RunnerEvent.array().parse(sampleEvents),
    files: { [QUESTIONS_PATH]: QUESTIONS },
    ...over,
  });
  return { ...built, ctx: { ...built.ctx, arm } };
}

const answers = (...yes: boolean[]): FakePlan =>
  FakeRunner.plans.judgeAnswer({
    answers: yes.map((y, i) => ({
      question: `q${String(i)}`,
      yes: y,
      reason: `reason ${String(i)}`,
    })),
  });

describe('gradeRun: deterministic graders', () => {
  it('passes and fails command graders with the full command detail', async () => {
    const { ctx } = setup([
      { type: 'command', run: 'echo ok' },
      { type: 'command', run: 'echo bad >&2; exit 3' },
    ]);
    const grades = await gradeRun(ctx);
    expect(Grade.array().parse(grades)).toEqual(grades);
    expect(grades[0]).toMatchObject({
      grader: { type: 'command', index: 0 },
      kind: 'deterministic',
      score: 1,
      passed: true,
      detail: { type: 'command', command: 'echo ok', exitCode: 0, stdout: 'ok\n', stderr: '' },
    });
    expect(grades[1]).toMatchObject({
      score: 0,
      passed: false,
      detail: { exitCode: 3, stdout: '', stderr: 'bad\n' },
    });
  });

  it('turns a command that cannot spawn into an error grade', async () => {
    const { ctx } = setup([{ type: 'command', run: 'pnpm test' }], {
      executor: stubExecutor({ failExec: new Error('spawn sh ENOENT') }),
    });
    expect(await gradeRun(ctx)).toEqual([
      {
        grader: { type: 'command', index: 0 },
        kind: 'deterministic',
        score: 0,
        passed: false,
        detail: { type: 'error', message: 'command "pnpm test" could not run: spawn sh ENOENT' },
      },
    ]);
  });

  it('checks file_exists in the run folder, quoting the path', async () => {
    await writeFile(join(runFolder, "it's here.txt"), '');
    const { ctx } = setup([
      { type: 'file_exists', path: "it's here.txt" },
      { type: 'file_exists', path: 'missing.txt' },
    ]);
    const grades = await gradeRun(ctx);
    expect(grades.map((g) => [g.passed, g.detail])).toEqual([
      [true, { type: 'check', message: "it's here.txt exists" }],
      [false, { type: 'check', message: 'missing.txt does not exist' }],
    ]);
  });

  it('reports a file_exists check that cannot run as an error', async () => {
    const { ctx } = setup([{ type: 'file_exists', path: 'a' }], {
      executor: stubExecutor({ failExec: new Error('boom') }),
    });
    const [grade] = await gradeRun(ctx);
    expect(grade?.detail).toEqual({ type: 'error', message: 'could not check a: boom' });
  });

  it('checks file_modified against the change files', async () => {
    const { ctx } = setup([
      { type: 'file_modified', path: './src/money.ts' },
      { type: 'file_modified', path: 'src/other.ts' },
    ]);
    const grades = await gradeRun(ctx);
    expect(grades.map((g) => [g.score, g.detail])).toEqual([
      [1, { type: 'check', message: 'src/money.ts is part of the change' }],
      [0, { type: 'check', message: 'src/other.ts is not part of the change' }],
    ]);
  });

  it('matches regex on the change (multiline) and on the transcript', async () => {
    const { ctx } = setup([
      { type: 'regex', pattern: '^\\+.*Math\\.round' },
      { type: 'regex', pattern: 'Math\\.ceil' },
      { type: 'regex', pattern: 'Read \\{"file_path":"src/money\\.ts"\\}', on: 'transcript' },
      { type: 'regex', pattern: 'Looking at', on: 'transcript' },
      { type: 'regex', pattern: 'export function refund', on: 'transcript' },
    ]);
    const grades = await gradeRun(ctx);
    expect(grades.map((g) => g.passed)).toEqual([true, false, true, true, false]);
    expect(grades[0]?.detail).toEqual({
      type: 'check',
      message: '/^\\+.*Math\\.round/ matched the change: "+  return Math.round"',
    });
    expect(grades[4]?.detail).toEqual({
      type: 'check',
      message: '/export function refund/ did not match the transcript',
    });
  });

  it('truncates a long regex match in the message', async () => {
    const { ctx } = setup([{ type: 'regex', pattern: 'x+' }], { diff: 'x'.repeat(300) });
    const [grade] = await gradeRun(ctx);
    expect(grade?.detail).toEqual({
      type: 'check',
      message: `/x+/ matched the change: "${'x'.repeat(200)}…"`,
    });
  });

  it('checks tool_used against tool_call events', async () => {
    const { ctx } = setup([
      { type: 'tool_used', tool: 'Read' },
      { type: 'tool_used', tool: 'Bash' },
    ]);
    const grades = await gradeRun(ctx);
    expect(grades.map((g) => [g.passed, g.detail])).toEqual([
      [true, { type: 'check', message: 'Read was called 1 time(s)' }],
      [false, { type: 'check', message: 'Bash was called 0 time(s)' }],
    ]);
  });
});

describe('gradeRun: hidden files', () => {
  const hiddenGraders = [
    { type: 'file_exists', path: 'tests/hidden/refund.spec.sh' },
    {
      type: 'command',
      run: 'sh tests/hidden/refund.spec.sh',
      hidden: ['tests/hidden/refund.spec.sh'],
    },
    {
      type: 'command',
      run: 'cat tests/hidden/data.txt',
      hidden: ['tests/hidden/refund.spec.sh', 'tests/hidden/data.txt'],
    },
  ];
  const files = {
    'tasks/refund-rounding/tests/hidden/refund.spec.sh': 'echo hidden-test-ran',
    'tasks/refund-rounding/tests/hidden/data.txt': 'data',
  };

  it('injects every hidden file exactly once, before any grader, and they are present', async () => {
    const { ctx, executor, suiteReads } = setup(hiddenGraders, { files });
    expect(existsSync(join(runFolder, 'tests/hidden/refund.spec.sh'))).toBe(false);
    const grades = await gradeRun(ctx);

    expect(executor.calls.map((c) => c.type)).toEqual(['inject', 'exec', 'exec', 'exec']);
    expect(executor.calls[0]).toEqual({
      type: 'inject',
      files: [
        { path: 'tests/hidden/refund.spec.sh', content: 'echo hidden-test-ran' },
        { path: 'tests/hidden/data.txt', content: 'data' },
      ],
    });
    expect(suiteReads).toEqual(Object.keys(files));
    expect(grades.map((g) => g.passed)).toEqual([true, true, true]);
    expect(grades[1]?.detail).toMatchObject({ stdout: 'hidden-test-ran\n' });
    expect(grades[2]?.detail).toMatchObject({ stdout: 'data' });
  });

  it('does not inject when no grader has hidden files', async () => {
    const { ctx, executor } = setup([{ type: 'command', run: 'true' }]);
    await gradeRun(ctx);
    expect(executor.calls).toEqual([{ type: 'exec', command: 'true' }]);
  });

  it('gives command graders an error grade, without running them, when injection fails', async () => {
    const { ctx, executor } = setup(hiddenGraders, { files: {} });
    const grades = await gradeRun(ctx);
    expect(executor.calls.filter((c) => c.type === 'exec')).toEqual([
      { type: 'exec', command: "test -e 'tests/hidden/refund.spec.sh'" },
    ]);
    expect(grades[1]).toEqual({
      grader: { type: 'command', index: 1 },
      kind: 'deterministic',
      score: 0,
      passed: false,
      detail: {
        type: 'error',
        message:
          'hidden files could not be injected: ENOENT: tasks/refund-rounding/tests/hidden/refund.spec.sh',
      },
    });
  });

  it('reports an executor that fails to inject', async () => {
    const { ctx } = setup(hiddenGraders.slice(1, 2), {
      files,
      executor: stubExecutor({ failInject: new Error('disk full') }),
    });
    const [grade] = await gradeRun(ctx);
    expect(grade?.detail).toEqual({
      type: 'error',
      message: 'hidden files could not be injected: disk full',
    });
  });
});

describe('gradeRun: checklist judge', () => {
  const graders = [
    { type: 'checklist', questions: QUESTIONS_PATH },
    { type: 'command', run: 'echo "3 tests passed"; echo "1 warning" >&2; exit 1' },
  ];

  it('asks the judge tool-less, one turn, isolated, and scores the count of yes', async () => {
    let judgeDirWasEmpty = false;
    const { ctx, runner } = setup(graders, {
      plan: (request) => {
        judgeDirWasEmpty = readdirSync(request.cwd).length === 0;
        return answers(true, false);
      },
    });
    const grades = await gradeRun(ctx);
    const [request] = runner.requests as [RunRequest];

    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      tools: 'none',
      maxTurns: 1,
      settingSources: [],
      sandbox: false,
      strictMcpConfig: true,
      limits: {},
      systemPrompt: CHECKLIST_SYSTEM_PROMPT,
      outputSchema: CHECKLIST_JUDGE_OUTPUT_SCHEMA,
    });
    expect(relative(runFolder, request.cwd).startsWith('..')).toBe(true);
    expect(judgeDirWasEmpty).toBe(true);

    expect(grades[0]).toEqual({
      grader: { type: 'checklist', index: 0 },
      kind: 'judge',
      score: 1,
      detail: {
        type: 'judge',
        model: 'claude-opus-5-5',
        reasoning:
          '1. Does it round half up? Yes: reason 0\n2. Does `refund` keep its signature? No: reason 1',
        raw: [
          {
            answers: [
              { question: 'q0', yes: true, reason: 'reason 0' },
              { question: 'q1', yes: false, reason: 'reason 1' },
            ],
          },
        ],
        answers: [
          { question: 'Does it round half up?', yes: true, note: 'reason 0' },
          { question: 'Does `refund` keep its signature?', yes: false, note: 'reason 1' },
        ],
      },
    });
    expect(grades[0]).not.toHaveProperty('passed');
    expect(grades[1]?.grader).toEqual({ type: 'command', index: 1 });
  });

  it('shows the task, the change, command output and the questions, never the arm', async () => {
    const { ctx, runner } = setup(graders, { plan: () => answers(true, true) });
    await gradeRun(ctx);
    const prompt = runner.requests[0]!.prompt;

    expect(prompt).toContain('Fix the rounding.');
    expect(prompt).toContain('+  return Math.round(amount * 100) / 100;');
    expect(prompt).toContain('Exit code: 1');
    expect(prompt).toContain('3 tests passed');
    expect(prompt).toContain('1 warning');
    expect(prompt).toContain('1. Does it round half up?\n2. Does `refund` keep its signature?');
    expect(prompt).not.toContain('Some prose');
    const everything = `${prompt}\n${runner.requests[0]!.systemPrompt ?? ''}`.toLowerCase();
    for (const word of ['control', 'treatment', 'always-green', 'variant', 'arm ']) {
      expect(everything).not.toContain(word);
    }
  });

  it('runs judges after every deterministic grader and returns declaration order', async () => {
    const order: string[] = [];
    const executor = stubExecutor();
    const { ctx } = setup(graders, {
      executor: {
        calls: executor.calls,
        injectHidden: executor.injectHidden,
        exec: (folder, command) => {
          order.push('exec');
          return executor.exec(folder, command);
        },
      },
      plan: () => {
        order.push('judge');
        return answers(true, true);
      },
    });
    const grades = await gradeRun(ctx);
    expect(order).toEqual(['exec', 'judge']);
    expect(grades.map((g) => g.grader.index)).toEqual([0, 1]);
  });

  it('averages repeats and keeps every answer', async () => {
    const plans = [answers(true, true), answers(true, false), answers(false, false)];
    const { ctx, runner } = setup([{ type: 'checklist', questions: QUESTIONS_PATH, repeats: 3 }], {
      plan: () => plans[runner.requests.length - 1]!,
    });
    const [grade] = await gradeRun(ctx);
    expect(runner.requests).toHaveLength(3);
    expect(grade?.score).toBe(1);
    if (grade?.detail.type !== 'judge') throw new Error('expected a judge detail');
    expect(grade.detail.raw).toHaveLength(3);
    expect(grade.detail.answers).toEqual([
      {
        question: 'Does it round half up?',
        yes: true,
        note: '1: yes, reason 0\n2: yes, reason 0\n3: no, reason 0',
      },
      {
        question: 'Does `refund` keep its signature?',
        yes: false,
        note: '1: yes, reason 1\n2: no, reason 1\n3: no, reason 1',
      },
    ]);
  });

  it('lets an agentic judge read the run folder, hidden files included', async () => {
    let hiddenPresent = false;
    const { ctx, runner } = setup(
      [
        { type: 'command', run: 'true', hidden: ['tests/h.sh'] },
        { type: 'checklist', questions: QUESTIONS_PATH, agentic: true },
      ],
      {
        files: { [QUESTIONS_PATH]: QUESTIONS, 'tasks/refund-rounding/tests/h.sh': 'x' },
        plan: (request) => {
          hiddenPresent = existsSync(join(request.cwd, 'tests/h.sh'));
          return answers(true, true);
        },
      },
    );
    const grades = await gradeRun(ctx);
    const [request] = runner.requests as [RunRequest];
    expect(request.tools).toBe('read_only');
    expect(request.cwd).toBe(runFolder);
    expect(request).not.toHaveProperty('maxTurns');
    expect(request.settingSources).toEqual([]);
    expect(request.systemPrompt).toContain('current directory');
    expect(request.prompt).not.toContain('tests/h.sh');
    expect(hiddenPresent).toBe(true);
    expect(grades[1]?.score).toBe(2);
  });

  it.each<[string, (request: RunRequest) => FakePlan, string]>([
    [
      'an answer of the wrong shape',
      () => FakeRunner.plans.judgeAnswer({ answers: [{ question: 'q', yes: 'yes' }] }),
      'judge answer is invalid: answers.0.yes: Invalid input: expected boolean, received string; answers.0.reason: Invalid input: expected string, received undefined',
    ],
    [
      'a missing top-level field',
      () => FakeRunner.plans.judgeAnswer('yes'),
      'judge answer is invalid: (root): Invalid input: expected object, received string',
    ],
    [
      'the wrong number of answers',
      () => answers(true),
      'judge answer is invalid: expected 2 answers, one per question, got 1',
    ],
    ['no structured output', () => ({}), 'judge returned no structured output'],
    [
      'a failed judge run',
      () => ({ result: { outcome: 'failed', structuredOutput: { answers: [] } } }),
      'judge run ended with outcome failed',
    ],
    [
      'a runner bug',
      () => {
        throw new Error('unexpected');
      },
      'judge could not run: unexpected',
    ],
  ])('scores 0 with an error detail for %s', async (_, plan, message) => {
    const { ctx } = setup([{ type: 'checklist', questions: QUESTIONS_PATH }], { plan });
    expect(await gradeRun(ctx)).toEqual([
      {
        grader: { type: 'checklist', index: 0 },
        kind: 'judge',
        score: 0,
        detail: { type: 'error', message },
      },
    ]);
  });

  it('names the failing repeat', async () => {
    const { ctx, runner } = setup([{ type: 'checklist', questions: QUESTIONS_PATH, repeats: 2 }], {
      plan: () => (runner.requests.length === 1 ? answers(true, true) : {}),
    });
    const [grade] = await gradeRun(ctx);
    expect(grade?.detail).toEqual({
      type: 'error',
      message: 'judge returned no structured output (repeat 2 of 2)',
    });
  });

  it('reports a missing or empty questions file without asking the judge', async () => {
    const { ctx, runner } = setup(
      [
        { type: 'checklist', questions: 'missing.md' },
        { type: 'checklist', questions: 'empty.md' },
        { type: 'checklist', questions: 'bytes.md' },
      ],
      {
        files: { 'empty.md': '# Nothing\n\nprose\n' },
      },
    );
    const withBytes = {
      ...ctx,
      suiteFiles: (path: string) =>
        path === 'bytes.md'
          ? Promise.resolve(new TextEncoder().encode('- [ ] Q?\n'))
          : ctx.suiteFiles(path),
    };
    const plan = answers(true);
    const judged = new FakeRunner({ clock: ctx.clock, plan: () => plan });
    const grades = await gradeRun({ ...withBytes, runner: judged });
    expect(grades.map((g) => g.detail)).toEqual([
      { type: 'error', message: 'could not read missing.md: ENOENT: missing.md' },
      { type: 'error', message: 'empty.md contains no question (expected list items)' },
      expect.objectContaining({
        type: 'judge',
        answers: [{ question: 'Q?', yes: true, note: 'reason 0' }],
      }),
    ]);
    expect(runner.requests).toHaveLength(0);
    expect(judged.requests).toHaveLength(1);
  });

  it('lets RunnerInfraError propagate', async () => {
    const error = new RunnerInfraError('rate_limited', 'slow down');
    const { ctx } = setup([{ type: 'checklist', questions: QUESTIONS_PATH }], {
      plan: () => ({ infraError: error }),
    });
    await expect(gradeRun(ctx)).rejects.toBe(error);
  });
});

describe('gradeRun: comparison graders', () => {
  it('leaves comparison graders to gradeComparisons', async () => {
    const { ctx, runner } = setup([{ type: 'comparison' }, { type: 'tool_used', tool: 'Read' }]);
    const grades = await gradeRun(ctx);
    expect(grades.map((g) => g.grader)).toEqual([{ type: 'tool_used', index: 1 }]);
    expect(runner.requests).toHaveLength(0);
  });
});

describe('gradeRun: prompt formatting', () => {
  it('shows an empty change, a signal kill, a spawn failure and trims long output', async () => {
    const executor = stubExecutor();
    let calls = 0;
    const { ctx, runner } = setup(
      [
        { type: 'command', run: 'killed' },
        { type: 'command', run: 'long' },
        { type: 'command', run: 'broken' },
        { type: 'checklist', questions: QUESTIONS_PATH },
      ],
      {
        diff: '',
        executor: {
          calls: executor.calls,
          injectHidden: executor.injectHidden,
          exec: (_folder, command) => {
            calls += 1;
            if (command === 'broken') return Promise.reject(new Error('ENOENT'));
            return Promise.resolve(
              command === 'killed'
                ? { exitCode: null, stdout: '', stderr: '', durationMs: 1 }
                : {
                    exitCode: 0,
                    stdout: `${'a'.repeat(10)}${'b'.repeat(10_000)}`,
                    stderr: '```',
                    durationMs: 1,
                  },
            );
          },
        },
        plan: () => answers(true, true),
      },
    );
    await gradeRun(ctx);
    const prompt = runner.requests[0]!.prompt;
    expect(calls).toBe(3);
    expect(prompt).toContain('No change: the agent modified no file.');
    expect(prompt).toContain('Command: killed\nKilled by a signal.');
    expect(prompt).toContain('[first 10 characters omitted]');
    expect(prompt).not.toContain('ab');
    expect(prompt).toContain('stderr:\n````\n```\n````');
    expect(prompt).toContain(
      'Command: broken\nCould not run: command "broken" could not run: ENOENT',
    );
  });
});
