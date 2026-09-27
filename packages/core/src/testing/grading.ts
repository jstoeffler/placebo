// Test support for graders: a tiny local `Executor` stub and a `GradingContext` builder over real
// temporary directories. Not the local executor adapter; just enough to run commands, inject
// hidden files and give judges real folders (copies are plain, not config-stripped).
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeRunner, type FakePlan } from '../adapters/fake-runner/fake-runner.js';
import { CONTROL } from '../domain/arm.js';
import type { RunnerEvent } from '../domain/events.js';
import { Task, type Task as TaskType } from '../domain/suite.js';
import type { GradingContext } from '../graders/context.js';
import type { Clock } from '../kernel/clock.js';
import { createSeededRandom } from '../kernel/random.js';
import type { ExecResult, Executor, HiddenFile, RunFolder } from '../ports/executor.js';
import type { RunRequest } from '../ports/runner.js';

export const fixedClock: Clock = { now: () => new Date('2026-09-27T10:00:00.000Z') };

/** Every call the stub executor received, in order. */
type ExecutorCall =
  | { readonly type: 'inject'; readonly files: readonly HiddenFile[] }
  | { readonly type: 'exec'; readonly command: string }
  | { readonly type: 'judge_folder'; readonly path: string; readonly from?: string }
  | { readonly type: 'remove'; readonly path: string };

export interface StubExecutor extends Pick<
  Executor,
  'exec' | 'injectHidden' | 'createJudgeFolder' | 'remove'
> {
  readonly calls: ExecutorCall[];
  /** Judge folders created and not yet removed. */
  readonly openJudgeFolders: Set<string>;
}

/**
 * Runs commands with `sh -c` in the run folder, writes hidden files with `fs`, and creates judge
 * folders as temporary directories (a plain copy when given a run folder).
 */
export function stubExecutor(
  options: { failExec?: Error; failInject?: Error; failJudgeFolder?: Error } = {},
): StubExecutor {
  const calls: ExecutorCall[] = [];
  const openJudgeFolders = new Set<string>();
  return {
    calls,
    openJudgeFolders,
    async createJudgeFolder(runFolder?: RunFolder): Promise<RunFolder> {
      if (options.failJudgeFolder) throw options.failJudgeFolder;
      const path = await mkdtemp(join(tmpdir(), 'placebo-judge-'));
      if (runFolder !== undefined) await cp(runFolder.path, path, { recursive: true });
      calls.push({
        type: 'judge_folder',
        path,
        ...(runFolder === undefined ? {} : { from: runFolder.path }),
      });
      openJudgeFolders.add(path);
      return { path, snapshotId: runFolder?.snapshotId ?? '' };
    },
    async remove(folder: RunFolder): Promise<void> {
      calls.push({ type: 'remove', path: folder.path });
      openJudgeFolders.delete(folder.path);
      await rm(folder.path, { recursive: true, force: true });
    },
    async injectHidden(runFolder: RunFolder, files: readonly HiddenFile[]): Promise<void> {
      calls.push({ type: 'inject', files });
      if (options.failInject) throw options.failInject;
      for (const file of files) {
        const target = join(runFolder.path, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
    },
    exec(runFolder: RunFolder, command: string): Promise<ExecResult> {
      calls.push({ type: 'exec', command });
      if (options.failExec) return Promise.reject(options.failExec);
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn('sh', ['-c', command], { cwd: runFolder.path });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - started });
        });
      });
    },
  };
}

/** Temporary directories created by a test, removed by `cleanup`. */
export class TempDirs {
  readonly #paths: string[] = [];

  async create(prefix = 'placebo-grading-'): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    this.#paths.push(path);
    return path;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.#paths.map((path) => rm(path, { recursive: true, force: true })));
    this.#paths.length = 0;
  }
}

export function task(input: {
  id?: string;
  prompt?: string;
  graders: readonly Record<string, unknown>[];
}): TaskType {
  return Task.parse({
    id: input.id ?? 'refund-rounding',
    prompt: input.prompt ?? 'Fix the rounding.',
    graders: input.graders,
  });
}

export interface ContextOptions {
  readonly task: TaskType;
  readonly runFolder: string;
  readonly executor?: StubExecutor;
  readonly plan?: (request: RunRequest) => FakePlan;
  readonly files?: Readonly<Record<string, string>>;
  readonly events?: readonly RunnerEvent[];
  readonly diff?: string;
  readonly changedFiles?: readonly string[];
}

/** A grading context over a real run folder, a stub executor and a fake runner. */
export function gradingContext(options: ContextOptions): {
  ctx: GradingContext;
  runner: FakeRunner;
  executor: StubExecutor;
  suiteReads: string[];
} {
  const executor = options.executor ?? stubExecutor();
  const runner = new FakeRunner({ clock: fixedClock, plan: options.plan ?? (() => ({})) });
  const suiteReads: string[] = [];
  const diff = options.diff ?? '';
  const ctx: GradingContext = {
    task: options.task,
    arm: CONTROL,
    runFolder: { path: options.runFolder, snapshotId: 'snap-1' },
    executor,
    runner,
    judgeModel: 'claude-opus-5-5',
    change: { diff, files: [...(options.changedFiles ?? [])], bytes: diff.length },
    events: options.events ?? [],
    outcome: 'completed',
    suiteFiles: (path) => {
      suiteReads.push(path);
      const content = options.files?.[path];
      return content === undefined
        ? Promise.reject(new Error(`ENOENT: ${path}`))
        : Promise.resolve(content);
    },
    random: createSeededRandom(1),
    clock: fixedClock,
  };
  return { ctx, runner, executor, suiteReads };
}
