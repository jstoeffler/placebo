import { join, resolve } from 'node:path';
import {
  type Clock,
  type Experiment,
  FakeRunner,
  FileSuiteSource,
  LocalExecutor,
  type Review,
  type Run,
  type RunFilter,
  type Runner,
  type RunStore,
} from '@placebo-eval/core';
import { CliRunner } from './adapters/cli-runner/cli-runner.js';
import { SdkRunner } from './adapters/sdk-runner/sdk-runner.js';
import { SqliteRunStore } from './adapters/sqlite-store/sqlite-run-store.js';
import { dataDirOf } from './data-dir.js';
import { createFakePlan } from './fake-plan.js';
import { repoRootOf } from './git.js';
import { VERSION } from './version.js';

type Env = Readonly<Record<string, string | undefined>>;

/** `sdk` by default; `cli` drives the installed `claude`; `fake` (hidden) spends nothing. */
export type RunnerKind = 'sdk' | 'cli' | 'fake';

/** Where everything of one repo lives. */
export interface Workspace {
  /** The git top level of the current directory. */
  readonly repoRoot: string;
  /** The suite folder: `--suite`, or `<repo>/.placebo`. */
  readonly suiteDir: string;
  /** Snapshots and run folders, outside the repo (ADR 0014). */
  readonly dataDir: string;
  /** The run store, next to the suite. */
  readonly storeDir: string;
  /** Default parent of report folders, next to the suite. */
  readonly reportsDir: string;
}

export async function workspaceOf(input: {
  readonly cwd: string;
  readonly suite?: string;
  readonly env: Env;
  readonly home?: string;
}): Promise<Workspace> {
  const repoRoot = await repoRootOf(input.cwd);
  const suiteDir =
    input.suite === undefined ? join(repoRoot, '.placebo') : resolve(input.cwd, input.suite);
  return {
    repoRoot,
    suiteDir,
    dataDir: dataDirOf(repoRoot, input.env, input.home),
    storeDir: join(suiteDir, 'runs'),
    reportsDir: join(suiteDir, 'reports'),
  };
}

/**
 * The repo to snapshot: a URL as written, any other path resolved against the repo root, so
 * `repo: .` means this repo wherever placebo is started from.
 */
export function resolveRepo(repo: string, repoRoot: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(repo) || /^[^/]+@[^/]+:/.test(repo)
    ? repo
    : resolve(repoRoot, repo);
}

export function createRunner(kind: RunnerKind, clock: Clock, env: Env): Runner {
  switch (kind) {
    case 'sdk':
      return new SdkRunner({ clock, env });
    case 'cli':
      return new CliRunner({ clock, env });
    case 'fake':
      return new FakeRunner({ clock, plan: createFakePlan() });
  }
}

export function createExecutor(workspace: Workspace, clock: Clock): LocalExecutor {
  return new LocalExecutor({ root: workspace.dataDir, clock, placeboVersion: VERSION });
}

export function createSuiteSource(workspace: Workspace): FileSuiteSource {
  return new FileSuiteSource(workspace.suiteDir);
}

export function openStore(workspace: Workspace): Promise<SqliteRunStore> {
  return new SqliteRunStore(workspace.storeDir).open();
}

/** A run store that tells `onSave` about every run it saves, e.g. to count spend. */
export class ObservedRunStore implements RunStore {
  readonly #inner: RunStore;
  readonly #onSave: (run: Run) => void;

  constructor(inner: RunStore, onSave: (run: Run) => void) {
    this.#inner = inner;
    this.#onSave = onSave;
  }

  async save(run: Run): Promise<void> {
    await this.#inner.save(run);
    this.#onSave(run);
  }

  get(id: Run['id']): Promise<Run | undefined> {
    return this.#inner.get(id);
  }

  list(filter?: RunFilter): Promise<Run[]> {
    return this.#inner.list(filter);
  }

  saveExperiment(experiment: Experiment): Promise<void> {
    return this.#inner.saveExperiment(experiment);
  }

  getExperiment(id: Experiment['id']): Promise<Experiment | undefined> {
    return this.#inner.getExperiment(id);
  }

  listExperiments(): Promise<Experiment[]> {
    return this.#inner.listExperiments();
  }

  saveReview(review: Review): Promise<void> {
    return this.#inner.saveReview(review);
  }

  listReviews(filter?: { readonly runId?: Run['id'] }): Promise<Review[]> {
    return this.#inner.listReviews(filter);
  }
}
