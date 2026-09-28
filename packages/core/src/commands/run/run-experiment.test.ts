import { stat } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeExecutor } from '../../adapters/fake-executor/fake-executor.js';
import { Results } from '../../domain/results.js';
import type { Run } from '../../domain/run.js';
import type { TaskId, VariantName } from '../../kernel/ids.js';
import type { ProgressEvent } from '../../ports/reporter.js';
import { RunnerInfraError, type RunRequest } from '../../ports/runner.js';
import {
  defaultPlan,
  GREETING_PROMPT,
  harness,
  REFUND_PROMPT,
  RULES_PATCH,
  type Harness,
  type HarnessOptions,
} from '../../testing/experiment.js';
import { runExperiment } from './run-experiment.js';

const executors: FakeExecutor[] = [];
afterEach(async () => {
  await Promise.all(executors.splice(0).map((executor) => executor.cleanup()));
});

function setup(options: HarnessOptions = {}): Harness {
  const h = harness(options);
  executors.push(h.executor);
  return h;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const typesOf = (events: readonly ProgressEvent[]): string[] => events.map((event) => event.type);
const isSubject = (request: RunRequest): boolean => request.outputSchema === undefined;

describe('runExperiment', () => {
  it('runs every task × arm × run, grades them, compares and assembles valid results', async () => {
    const h = setup();
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    const { experiment, results } = result.value;

    expect(Results.parse(results)).toEqual(results);
    expect(experiment).toMatchObject({
      id: '20260927-100000-0000002a',
      runsPerTask: 2,
      taskIds: ['refund', 'greeting'],
      arms: [
        { kind: 'control' },
        { kind: 'treatment', variant: 'rules', patch: 'variants/rules.patch' },
      ],
      seed: 42,
      pins: {
        subjectModel: 'claude-sonnet-5',
        judgeModel: 'claude-opus-5-5',
        claudeCodeVersion: '2.1.283',
        suiteHash: h.input.suiteHash,
        placeboVersion: '0.0.0',
      },
    });
    expect(experiment.pins.commit).toMatch(/^[0-9a-f]{40}$/);
    await expect(h.store.getExperiment(experiment.id)).resolves.toEqual(experiment);

    const stored = await h.store.list({ experimentId: experiment.id });
    expect(stored).toHaveLength(8);
    expect(results.runs).toHaveLength(8);
    for (const run of stored) {
      expect(run.outcome).toBe('completed');
      const types = run.grades.map((grade) => grade.grader.type);
      const comparisons = types.filter((type) => type === 'comparison').length;
      if (run.taskId === 'refund') {
        expect(types.slice(0, 3)).toEqual(['command', 'file_modified', 'checklist']);
        expect(comparisons).toBe(run.arm.kind === 'treatment' ? 1 : 0);
      } else {
        expect(types).toEqual(['command', 'file_modified']);
      }
      expect(run.grades.find((grade) => grade.grader.type === 'file_modified')?.passed).toBe(true);
      expect(run.runFolder).toBeDefined();
      expect(run.infraRetries).toBe(0);
    }

    expect(results.verdictCards.map((card) => card.variant)).toEqual(['rules']);
    expect(results.verdictCards[0]?.rows.map((row) => row.metric)).toContain('passRate');
    expect(results.tasks[0]?.graders.map((grader) => grader.label)).toEqual([
      'command: sh check.sh',
      'file_modified: src/money.ts',
      'checklist: tasks/refund/checklist.md',
      'comparison',
    ]);
    expect(results.warnings).toContainEqual({ type: 'few_tasks', taskCount: 2, threshold: 5 });

    const types = typesOf(h.events);
    expect(types.slice(0, 3)).toEqual(['message', 'snapshot_ready', 'experiment_started']);
    expect(types.filter((type) => type === 'run_started')).toHaveLength(8);
    expect(types.filter((type) => type === 'grading_started')).toHaveLength(8);
    expect(types.filter((type) => type === 'run_finished')).toHaveLength(8);
    expect(h.events.filter((event) => event.type === 'comparisons_started')).toEqual([
      { type: 'comparisons_started', taskId: 'refund', treatment: 'rules', pairs: 2 },
    ]);
    expect(types.indexOf('comparisons_started')).toBeGreaterThan(types.lastIndexOf('run_finished'));
    expect(h.events.at(-1)).toEqual({
      type: 'experiment_finished',
      experimentId: experiment.id,
      completedRuns: 8,
      totalRuns: 8,
      durationMs: 0,
    });
    expect(h.events.find((event) => event.type === 'experiment_started')).toEqual({
      type: 'experiment_started',
      experimentId: experiment.id,
      totalRuns: 8,
    });
  });

  it('sends the bare prompt with project settings, the sandbox, strict MCP and the suite limits', async () => {
    const h = setup({
      suite: { runs: 1, sandbox: false, limits: { maxTurns: 30 } },
      options: { tasks: ['greeting' as TaskId] },
    });
    const controller = new AbortController();
    const result = await runExperiment({
      ...h.input,
      options: { ...h.input.options, signal: controller.signal },
    });
    expect(result.ok).toBe(true);
    const subject = h.runner.requests.filter(isSubject);
    expect(subject).toHaveLength(2);
    const [first] = subject;
    expect(first).toEqual({
      cwd: expect.any(String) as unknown,
      prompt: GREETING_PROMPT,
      model: 'claude-sonnet-5',
      settingSources: ['project'],
      sandbox: false,
      strictMcpConfig: true,
      limits: { maxTurns: 30 },
      tools: 'all',
      signal: controller.signal,
    });
    const patches = h.executor.calls.flatMap((call) =>
      call.method === 'createRunFolder' ? [call.patch] : [],
    );
    expect(patches.sort()).toEqual([RULES_PATCH, undefined]);
  });

  it('interleaves arms in an order fixed by the seed', async () => {
    const order = async (seed: number): Promise<string[]> => {
      const h = setup({ seed, suite: { runs: 3, parallelism: 1 } });
      const result = await runExperiment(h.input);
      expect(result.ok).toBe(true);
      return h.events.flatMap((event) =>
        event.type === 'run_started' ? [`${event.taskId}/${event.arm}`] : [],
      );
    };
    const taskMajor = ['refund', 'greeting'].flatMap((task) =>
      ['control', 'rules'].flatMap((arm) => Array.from({ length: 3 }, () => `${task}/${arm}`)),
    );
    const a = await order(7);
    expect(a).toHaveLength(12);
    expect(a).not.toEqual(taskMajor);
    expect([...a].sort()).toEqual([...taskMajor].sort());
    expect(await order(7)).toEqual(a);
    expect(await order(8)).not.toEqual(a);
  });

  it('never has more runs in flight than parallelism', async () => {
    let inFlight = 0;
    let peak = 0;
    const plan = (request: RunRequest) => {
      if (!isSubject(request)) return defaultPlan(request);
      return {
        ...defaultPlan(request),
        steps: [
          {
            wait: async () => {
              inFlight += 1;
              peak = Math.max(peak, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 5));
              inFlight -= 1;
            },
          },
          ...(defaultPlan(request).steps ?? []),
        ],
      };
    };
    const h = setup({ plan, suite: { runs: 3 }, options: { parallelism: 3 } });
    const result = await runExperiment(h.input);
    expect(result.ok).toBe(true);
    expect(peak).toBe(3);

    peak = 0;
    const serial = setup({ plan, suite: { runs: 2 }, options: { parallelism: 1 } });
    expect((await runExperiment(serial.input)).ok).toBe(true);
    expect(peak).toBe(1);
  });

  it('retries an infrastructure error from a fresh run folder after a backoff', async () => {
    const plan = (request: RunRequest) =>
      isSubject(request) ? { ...defaultPlan(request), failAttempts: 2 } : defaultPlan(request);
    const h = setup({
      plan,
      suite: { runs: 1, parallelism: 1 },
      options: { tasks: ['greeting' as TaskId], variants: ['rules' as VariantName] },
    });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);

    const retried = h.events.filter((event) => event.type === 'run_retried');
    const firstRun = h.events.find((event) => event.type === 'run_started');
    if (firstRun?.type !== 'run_started') throw new Error('no run started');
    expect(retried).toEqual([
      {
        type: 'run_retried',
        runId: firstRun.runId,
        attempt: 1,
        reason: 'rate_limited',
        delayMs: h.sleeps[0],
      },
      {
        type: 'run_retried',
        runId: firstRun.runId,
        attempt: 2,
        reason: 'rate_limited',
        delayMs: h.sleeps[1],
      },
    ]);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(1000);
    expect(h.sleeps[0]).toBeLessThan(1250);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(2000);
    expect(h.sleeps[1]).toBeLessThan(2500);

    const calls = h.executor.calls.map((call) => call.method);
    const folders = h.executor.calls.flatMap((call) =>
      call.method === 'createRunFolder' ? [call.snapshotId] : [],
    );
    expect(folders).toHaveLength(4);
    expect(calls.slice(1, 5)).toEqual(['createRunFolder', 'remove', 'createRunFolder', 'remove']);
    const stored = await h.store.list();
    const retriedRun = stored.find((run) => run.id === firstRun.runId);
    expect(retriedRun?.infraRetries).toBe(2);
    expect(stored.map((run) => run.infraRetries).sort()).toEqual([0, 2]);
  });

  it('ends with infra_exhausted after maxInfraAttempts and keeps the runs already saved', async () => {
    const plan = (request: RunRequest) =>
      request.prompt === REFUND_PROMPT
        ? { ...defaultPlan(request), failAttempts: 5 }
        : defaultPlan(request);
    const h = setup({
      plan,
      seed: 3,
      suite: { runs: 1, parallelism: 1 },
      options: { maxInfraAttempts: 5 },
    });
    const result = await runExperiment(h.input);
    if (result.ok) throw new Error('expected infra_exhausted');
    const refundRun = h.events.find(
      (event) => event.type === 'run_started' && event.taskId === 'refund',
    );
    const stored = await h.store.list();
    expect(result.error).toEqual({
      type: 'infra_exhausted',
      experimentId: expect.any(String) as unknown,
      completedRuns: stored.length,
      totalRuns: 4,
      runId: refundRun?.type === 'run_started' ? refundRun.runId : undefined,
      reason: 'rate_limited',
      attempts: 5,
      message: 'fake rate limit on attempt 5',
    });
    expect(h.sleeps).toHaveLength(4);
    expect(stored.every((run) => run.taskId === 'greeting')).toBe(true);
    expect(h.events.at(-1)).toMatchObject({
      type: 'experiment_finished',
      completedRuns: stored.length,
    });
  });

  it('injects hidden files only after the runner returned', async () => {
    const order: string[] = [];
    const plan = (request: RunRequest) => {
      if (isSubject(request)) order.push('runner');
      return defaultPlan(request);
    };
    const h = setup({
      plan,
      suite: { runs: 1, parallelism: 1 },
      options: { tasks: ['refund' as TaskId] },
    });
    const inject = h.executor.injectHidden.bind(h.executor);
    h.executor.injectHidden = (folder, files) => {
      order.push(`inject:${files.map((file) => file.path).join(',')}`);
      return inject(folder, files);
    };
    const result = await runExperiment(h.input);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['runner', 'inject:check.sh', 'runner', 'inject:check.sh']);
    const injected = h.executor.calls.find((call) => call.method === 'injectHidden');
    expect(
      injected?.method === 'injectHidden' &&
        new TextDecoder().decode(injected.files[0]?.content as Uint8Array),
    ).toBe('grep -q round src/money.ts\n');
  });

  it('warns up front: judge equals subject, patch outside the surface, few tasks', async () => {
    const outside =
      'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const h = setup({
      suite: { judgeModel: 'claude-sonnet-5', runs: 1 },
      files: { 'variants/rules.patch': outside },
    });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    const messages = h.events.filter((event) => event.type === 'message');
    expect(messages).toEqual([
      {
        type: 'message',
        level: 'warn',
        text: 'the judge model is the subject model (claude-sonnet-5); a model grading its own work favours it',
      },
      {
        type: 'message',
        level: 'warn',
        text: 'variant "rules" touches files outside the configuration surface: src/app.ts',
      },
      {
        type: 'message',
        level: 'warn',
        text: 'only 2 tasks (fewer than 5): results describe these tasks, not the repo in general',
      },
    ]);
    expect(typesOf(h.events).indexOf('message')).toBe(0);
    expect(result.value.results.warnings).toEqual(
      expect.arrayContaining([
        { type: 'judge_equals_subject', model: 'claude-sonnet-5' },
        { type: 'patch_outside_surface', variant: 'rules', paths: ['src/app.ts'] },
        { type: 'few_tasks', taskCount: 2, threshold: 5 },
      ]),
    );
    expect(result.value.results.warnings.filter((w) => w.type === 'few_tasks')).toHaveLength(1);
  });

  it.each([
    ['all', { refund: true, greeting: true }],
    ['reviewable', { refund: true, greeting: false }],
    ['none', { refund: false, greeting: false }],
  ] as const)('keepRunFolders %s keeps the right run folders', async (policy, kept) => {
    const h = setup({ suite: { runs: 1 }, options: { keepRunFolders: policy } });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    for (const run of await h.store.list()) {
      expect(run.runFolder !== undefined).toBe(kept[run.taskId as 'refund' | 'greeting']);
      if (run.runFolder !== undefined) expect(await exists(run.runFolder)).toBe(true);
    }
    const removed = h.executor.calls.filter((call) => call.method === 'remove').length;
    const judgeFolders = h.executor.calls.filter(
      (call) => call.method === 'createJudgeFolder',
    ).length;
    const expectedRemoved = (kept.refund ? 0 : 2) + (kept.greeting ? 0 : 2);
    expect(removed - judgeFolders).toBe(expectedRemoved);
    expect((await h.executor.listRunFolders()).length).toBe(4 - expectedRemoved);
  });

  it.each(['all', 'none'] as const)(
    'stops on abort: no new run starts and the run in flight is discarded (keepRunFolders %s)',
    async (keepRunFolders) => {
      const controller = new AbortController();
      let started = 0;
      const plan = (request: RunRequest) => {
        if (!isSubject(request)) return defaultPlan(request);
        started += 1;
        if (started < 3) return defaultPlan(request);
        return {
          steps: [
            {
              wait: () => {
                controller.abort();
                return new Promise(() => undefined);
              },
            },
          ],
        };
      };
      const h = setup({
        plan,
        suite: { runs: 2, parallelism: 1 },
        options: { signal: controller.signal, keepRunFolders },
      });
      const result = await runExperiment(h.input);
      if (result.ok) throw new Error('expected aborted');
      expect(result.error).toMatchObject({ type: 'aborted', completedRuns: 2, totalRuns: 8 });
      expect(started).toBe(3);
      const stored = await h.store.list();
      expect(stored).toHaveLength(2);
      expect(stored.every((run) => run.grades.length > 0)).toBe(true);
      const runStarted = h.events.flatMap((event) =>
        event.type === 'run_started' ? [event.runId] : [],
      );
      const runFinished = h.events.flatMap((event) =>
        event.type === 'run_finished' ? [event.runId] : [],
      );
      expect(runStarted).toHaveLength(3);
      expect([...runFinished].sort()).toEqual(stored.map((run) => run.id).sort());
      expect(runFinished).not.toContain(runStarted[2]);
      expect(h.events.at(-1)).toMatchObject({ type: 'experiment_finished', completedRuns: 2 });
      expect(typesOf(h.events)).not.toContain('comparisons_started');
      const folders = await h.executor.listRunFolders();
      expect(folders).toHaveLength(keepRunFolders === 'all' ? 2 : 0);
    },
  );

  it('ends at once when the signal fired before anything started', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = setup({ options: { signal: controller.signal } });
    const result = await runExperiment(h.input);
    expect(result).toEqual({
      ok: false,
      error: {
        type: 'aborted',
        completedRuns: 0,
        totalRuns: 8,
        message: 'aborted after 0 of 8 runs',
      },
    });
    expect(h.executor.calls).toEqual([]);
  });

  it('gives identical run keys to two experiments over the same suite', async () => {
    const keysOf = (runs: readonly Run[]) =>
      Object.fromEntries(runs.map((run) => [`${run.taskId}/${run.arm.kind}`, run.key]));
    const first = setup({ suite: { runs: 1 }, seed: 1 });
    const second = setup({ suite: { runs: 1 }, seed: 2 });
    const a = await runExperiment(first.input);
    const b = await runExperiment(second.input);
    if (!a.ok || !b.ok) throw new Error('expected both experiments to finish');
    expect(a.value.experiment.id).not.toBe(b.value.experiment.id);
    expect(keysOf(b.value.results.runs)).toEqual(keysOf(a.value.results.runs));
    const control = a.value.results.runs.find((run) => run.arm.kind === 'control');
    const treatment = a.value.results.runs.find(
      (run) => run.arm.kind === 'treatment' && run.taskId === control?.taskId,
    );
    expect(control?.key.variantHash).not.toBe(treatment?.key.variantHash);
    expect(control?.key.taskHash).toBe(treatment?.key.taskHash);
    expect(control?.key.commitHash).toBe(a.value.experiment.pins.commit);
  });

  it('counts an agent failure as a failed run, never as an error', async () => {
    const plan = (request: RunRequest) =>
      isSubject(request) && request.prompt === GREETING_PROMPT
        ? { result: { outcome: 'crashed' as const } }
        : defaultPlan(request);
    const h = setup({ plan, suite: { runs: 1 } });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    const greeting = result.value.results.runs.filter((run) => run.taskId === 'greeting');
    expect(greeting.map((run) => run.outcome)).toEqual(['crashed', 'crashed']);
  });
});

describe('runExperiment selection and pins', () => {
  it('runs only the selected tasks and variants', async () => {
    const h = setup({
      suite: {
        runs: 1,
        variants: {
          rules: { patch: 'variants/rules.patch' },
          other: { patch: 'variants/rules.patch' },
        },
      },
      options: { tasks: ['greeting' as TaskId], variants: ['other' as VariantName], runs: 2 },
    });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.experiment).toMatchObject({
      taskIds: ['greeting'],
      runsPerTask: 2,
      arms: [{ kind: 'control' }, { kind: 'treatment', variant: 'other' }],
    });
    expect(result.value.results.runs).toHaveLength(4);
  });

  it.each([
    [{ tasks: ['nope' as TaskId] }, 'no_tasks', 'the suite has no task "nope"'],
    [{ tasks: [] }, 'no_tasks', 'no task selected'],
    [{ variants: ['nope' as VariantName] }, 'no_treatments', 'the suite has no variant "nope"'],
    [{ variants: [] }, 'no_treatments', 'no variant selected'],
  ])('rejects the selection %j', async (options, type, message) => {
    const h = setup({ options });
    const result = await runExperiment(h.input);
    expect(result).toEqual({ ok: false, error: { type, completedRuns: 0, totalRuns: 0, message } });
    expect(h.executor.calls).toEqual([]);
  });

  it('ends with executor_failed when the snapshot cannot be prepared', async () => {
    const h = setup();
    h.executor.prepareSnapshot = () => Promise.reject(new Error('commit not found'));
    const result = await runExperiment(h.input);
    expect(result).toEqual({
      ok: false,
      error: {
        type: 'executor_failed',
        completedRuns: 0,
        totalRuns: 8,
        message: 'the snapshot could not be prepared: commit not found',
      },
    });
    await expect(h.store.listExperiments()).resolves.toEqual([]);
  });

  it('ends with executor_failed when a run folder cannot be created', async () => {
    const h = setup({ suite: { parallelism: 1 } });
    const create = h.executor.createRunFolder.bind(h.executor);
    let created = 0;
    h.executor.createRunFolder = (snapshot, patch) => {
      created += 1;
      return created === 3 ? Promise.reject(new Error('disk full')) : create(snapshot, patch);
    };
    const result = await runExperiment(h.input);
    expect(result.ok ? undefined : result.error).toMatchObject({
      type: 'executor_failed',
      completedRuns: 2,
      totalRuns: 8,
      message: 'the run folder could not be created: disk full',
    });
    await expect(h.store.list()).resolves.toHaveLength(2);
  });

  it('ends with infra_exhausted when the Claude Code version cannot be read', async () => {
    const h = setup();
    h.runner.claudeCodeVersion = () =>
      Promise.reject(new RunnerInfraError('spawn_failed', 'ENOENT claude'));
    const result = await runExperiment(h.input);
    expect(result).toEqual({
      ok: false,
      error: {
        type: 'infra_exhausted',
        reason: 'spawn_failed',
        attempts: 1,
        completedRuns: 0,
        totalRuns: 8,
        message: 'the Claude Code version could not be read: ENOENT claude',
      },
    });
  });

  it('rethrows what is not an infrastructure error: a bug', async () => {
    const h = setup();
    h.runner.claudeCodeVersion = () => Promise.reject(new TypeError('bug'));
    await expect(runExperiment(h.input)).rejects.toThrow('bug');
    const broken = setup({ plan: () => ({ steps: [{ write: { path: '../x', content: '' } }] }) });
    await expect(runExperiment(broken.input)).rejects.toThrow('outside the run folder');
  });
});

describe('runExperiment grading and comparison retries', () => {
  it('retries a judge infrastructure error by regrading, not by rerunning the agent', async () => {
    let judgeCalls = 0;
    const plan = (request: RunRequest) => {
      if (!isSubject(request) && request.prompt.includes('Rounds half up?')) {
        judgeCalls += 1;
        if (judgeCalls === 1)
          return { infraError: new RunnerInfraError('network', 'socket hang up') };
      }
      return defaultPlan(request);
    };
    const h = setup({
      plan,
      suite: { runs: 1, parallelism: 1 },
      options: { tasks: ['refund' as TaskId], variants: ['rules' as VariantName] },
    });
    const result = await runExperiment(h.input);
    if (!result.ok) throw new Error(result.error.message);
    expect(h.runner.requests.filter(isSubject)).toHaveLength(2);
    expect(h.events.filter((event) => event.type === 'run_retried')).toMatchObject([
      { attempt: 1, reason: 'network' },
    ]);
    expect(result.value.results.runs.map((run) => run.infraRetries).sort()).toEqual([0, 1]);
  });

  it('ends with infra_exhausted when grading keeps failing', async () => {
    const plan = (request: RunRequest) =>
      !isSubject(request) && request.prompt.includes('Rounds half up?')
        ? { infraError: new RunnerInfraError('network', 'socket hang up') }
        : defaultPlan(request);
    const h = setup({
      plan,
      suite: { runs: 1, parallelism: 1 },
      options: { tasks: ['refund' as TaskId], maxInfraAttempts: 2 },
    });
    const result = await runExperiment(h.input);
    expect(result.ok ? undefined : result.error).toMatchObject({
      type: 'infra_exhausted',
      reason: 'network',
      attempts: 2,
      completedRuns: 0,
    });
    await expect(h.store.list()).resolves.toEqual([]);
    expect(await h.executor.listRunFolders()).toEqual([]);
  });

  it('retries comparisons after a backoff and gives up after maxInfraAttempts', async () => {
    let comparisonCalls = 0;
    const failing = (times: number) => (request: RunRequest) => {
      if (!isSubject(request) && !request.prompt.includes('Rounds half up?')) {
        comparisonCalls += 1;
        if (comparisonCalls <= times) {
          return {
            infraError: new RunnerInfraError('rate_limited', 'slow down', { retryAfterMs: 5000 }),
          };
        }
      }
      return defaultPlan(request);
    };
    const once = setup({
      plan: failing(1),
      suite: { runs: 1 },
      options: { tasks: ['refund' as TaskId] },
    });
    const recovered = await runExperiment(once.input);
    if (!recovered.ok) throw new Error(recovered.error.message);
    expect(once.sleeps).toHaveLength(1);
    expect(once.sleeps[0]).toBeGreaterThanOrEqual(5000);
    expect(once.events.filter((event) => event.type === 'message').at(-1)).toMatchObject({
      level: 'warn',
      text: expect.stringContaining(
        'comparisons of task "refund" for "rules" hit an infrastructure error (rate_limited)',
      ) as unknown,
    });
    const treatment = recovered.value.results.runs.find((run) => run.arm.kind === 'treatment');
    expect(treatment?.grades.at(-1)?.grader.type).toBe('comparison');

    comparisonCalls = 0;
    const always = setup({
      plan: failing(99),
      suite: { runs: 1 },
      options: { tasks: ['refund' as TaskId], maxInfraAttempts: 3 },
    });
    const exhausted = await runExperiment(always.input);
    expect(exhausted.ok ? undefined : exhausted.error).toMatchObject({
      type: 'infra_exhausted',
      reason: 'rate_limited',
      attempts: 3,
      completedRuns: 2,
    });
    expect(exhausted.ok ? undefined : exhausted.error).not.toHaveProperty('runId');
  });

  it('stops before comparisons when aborted after the last run', async () => {
    const controller = new AbortController();
    const h = setup({
      suite: { runs: 1 },
      options: { tasks: ['refund' as TaskId], signal: controller.signal },
    });
    const save = h.store.save.bind(h.store);
    let saves = 0;
    h.store.save = async (run) => {
      await save(run);
      saves += 1;
      if (saves === 2) controller.abort();
    };
    const result = await runExperiment(h.input);
    expect(result.ok ? undefined : result.error).toMatchObject({
      type: 'aborted',
      completedRuns: 2,
    });
    expect(typesOf(h.events)).not.toContain('comparisons_started');
  });

  it('stops between comparisons when aborted after the first treatment was compared', async () => {
    const controller = new AbortController();
    const h = setup({
      suite: {
        runs: 1,
        variants: {
          rules: { patch: 'variants/rules.patch' },
          again: { patch: 'variants/rules.patch' },
        },
      },
      options: { tasks: ['refund' as TaskId], signal: controller.signal },
    });
    const save = h.store.save.bind(h.store);
    h.store.save = async (run) => {
      await save(run);
      if (run.grades.some((grade) => grade.grader.type === 'comparison')) controller.abort();
    };
    const result = await runExperiment(h.input);
    expect(result.ok ? undefined : result.error).toMatchObject({
      type: 'aborted',
      completedRuns: 3,
    });
    expect(h.events.filter((event) => event.type === 'comparisons_started')).toHaveLength(1);
  });
});

describe('runExperiment abort before the agent started', () => {
  it('removes the fresh run folder and saves nothing for that run', async () => {
    const controller = new AbortController();
    const h = setup({ suite: { runs: 1, parallelism: 1 }, options: { signal: controller.signal } });
    const create = h.executor.createRunFolder.bind(h.executor);
    let created = 0;
    h.executor.createRunFolder = async (snapshot, patch) => {
      const folder = await create(snapshot, patch);
      created += 1;
      if (created === 2) controller.abort(new Error('ctrl-c'));
      return folder;
    };
    const result = await runExperiment(h.input);
    expect(result.ok ? undefined : result.error).toMatchObject({
      type: 'aborted',
      completedRuns: 1,
    });
    await expect(h.store.list()).resolves.toHaveLength(1);
    expect(await h.executor.listRunFolders()).toHaveLength(1);
  });
});
