import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Change } from '../../domain/change.js';
import { sha256 } from '../../kernel/hash.js';
import type { CommitSha } from '../../kernel/ids.js';
import type {
  ExecResult,
  Executor,
  HiddenFile,
  RunFolder,
  Snapshot,
} from '../../ports/executor.js';

export interface FakeExecutorOptions {
  /** Virtual root for snapshot and run folder paths. Defaults to `/placebo-fake`. */
  readonly root?: string;
  /** Create each run folder as a real empty temp directory, so a fake runner can write files. */
  readonly realDirs?: boolean;
  /** What `computeChange` returns; an empty change by default. */
  readonly change?: Change | ((runFolder: RunFolder) => Change);
  /**
   * What `exec` returns: by exact command, or computed. Missing fields and unknown commands
   * default to exit code 0 with empty output.
   */
  readonly exec?:
    | Readonly<Record<string, Partial<ExecResult>>>
    | ((runFolder: RunFolder, command: string) => Partial<ExecResult>);
}

export type FakeExecutorCall =
  | {
      readonly method: 'prepareSnapshot';
      readonly repo: string;
      readonly commit: string;
      readonly setup?: string;
    }
  | { readonly method: 'createRunFolder'; readonly snapshotId: string; readonly patch?: string }
  | { readonly method: 'computeChange'; readonly path: string }
  | {
      readonly method: 'injectHidden';
      readonly path: string;
      readonly files: readonly HiddenFile[];
    }
  | { readonly method: 'exec'; readonly path: string; readonly command: string }
  | { readonly method: 'remove'; readonly path: string };

const EMPTY_CHANGE: Change = { diff: '', files: [], bytes: 0 };
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * In-memory `Executor` for command tests: no git, no disk unless `realDirs`. Snapshots are
 * deterministic, run folders are numbered, and every call is recorded in `calls`.
 */
export class FakeExecutor implements Executor {
  readonly calls: FakeExecutorCall[] = [];
  private readonly root: string;
  private readonly options: FakeExecutorOptions;
  private readonly folders: RunFolder[] = [];
  private created = 0;

  constructor(options: FakeExecutorOptions = {}) {
    this.options = options;
    this.root = options.root ?? '/placebo-fake';
  }

  prepareSnapshot(input: {
    readonly repo: string;
    readonly commit: string;
    readonly setup?: string;
  }): Promise<Snapshot> {
    this.calls.push({ method: 'prepareSnapshot', ...input });
    const commit = (
      FULL_COMMIT.test(input.commit) ? input.commit : sha256(input.commit).slice(0, 40)
    ) as CommitSha;
    const id = `${commit}-${sha256(input.setup ?? '').slice(0, 12)}`;
    return Promise.resolve({ id, path: join(this.root, 'snapshots', id), commit });
  }

  async createRunFolder(snapshot: Snapshot, patch?: string): Promise<RunFolder> {
    this.calls.push({
      method: 'createRunFolder',
      snapshotId: snapshot.id,
      ...(patch === undefined ? {} : { patch }),
    });
    this.created++;
    const path =
      this.options.realDirs === true
        ? await mkdtemp(join(tmpdir(), 'placebo-fake-run-'))
        : join(this.root, 'folders', `run-${String(this.created)}`);
    const folder = { path, snapshotId: snapshot.id };
    this.folders.push(folder);
    return folder;
  }

  computeChange(runFolder: RunFolder): Promise<Change> {
    this.calls.push({ method: 'computeChange', path: runFolder.path });
    const change = this.options.change ?? EMPTY_CHANGE;
    return Promise.resolve(typeof change === 'function' ? change(runFolder) : change);
  }

  injectHidden(runFolder: RunFolder, files: readonly HiddenFile[]): Promise<void> {
    this.calls.push({ method: 'injectHidden', path: runFolder.path, files });
    return Promise.resolve();
  }

  exec(runFolder: RunFolder, command: string): Promise<ExecResult> {
    this.calls.push({ method: 'exec', path: runFolder.path, command });
    const script = this.options.exec ?? {};
    const scripted = typeof script === 'function' ? script(runFolder, command) : script[command];
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, ...scripted });
  }

  async remove(runFolder: RunFolder): Promise<void> {
    this.calls.push({ method: 'remove', path: runFolder.path });
    const index = this.folders.findIndex((folder) => folder.path === runFolder.path);
    if (index !== -1) this.folders.splice(index, 1);
    if (this.options.realDirs === true) await rm(runFolder.path, { recursive: true, force: true });
  }

  listRunFolders(): Promise<RunFolder[]> {
    return Promise.resolve([...this.folders]);
  }

  /** Deletes every real directory still listed; call it in `afterEach` when using `realDirs`. */
  async cleanup(): Promise<void> {
    for (const folder of [...this.folders]) await this.remove(folder);
  }
}
