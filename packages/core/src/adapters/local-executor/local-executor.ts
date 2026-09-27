import { randomUUID } from 'node:crypto';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Change } from '../../domain/change.js';
import { systemClock, type Clock } from '../../kernel/clock.js';
import { sha256 } from '../../kernel/hash.js';
import type { CommitSha } from '../../kernel/ids.js';
import type {
  CopyMethod,
  ExecResult,
  Executor,
  HiddenFile,
  RunFolder,
  Snapshot,
} from '../../ports/executor.js';
import { ExecutorError, type ExecutorErrorReason } from './executor-error.js';
import { isConfigurationSurface, patchPaths } from './patch-paths.js';
import { spawnProcess, type ProcessOutput, type ProcessRunner } from './process.js';

export interface LocalExecutorOptions {
  /** Where snapshots and run folders live. Defaults to `.placebo` in the current directory. */
  readonly root?: string;
  readonly clock?: Clock;
  /** Starts child processes; tests pass a spy. */
  readonly run?: ProcessRunner;
  /** Selects the copy command; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Recorded in each snapshot's marker file. */
  readonly placeboVersion?: string;
  /** Run folder ids; defaults to random UUIDs. */
  readonly newId?: () => string;
}

/** Written next to a snapshot directory, last, once the snapshot is complete. */
interface SnapshotMarker {
  readonly commit: string;
  readonly setup: string | null;
  readonly createdAt: string;
  readonly placeboVersion?: string;
}

/** Written next to a run folder, outside it so the agent never sees it. */
interface RunFolderRecord {
  readonly kind: 'run';
  readonly snapshotId: string;
  /** The single commit after the amend: the base `computeChange` diffs against. */
  readonly baseCommit: string;
  readonly copyMethod: CopyMethod;
  readonly createdAt: string;
}

/** Written next to a judge folder; marks it as one so `listRunFolders` leaves it out. */
interface JudgeFolderRecord {
  readonly kind: 'judge';
  /** The snapshot of the run folder it copies; empty for an empty judge folder. */
  readonly snapshotId: string;
  /** The run folder it copies, if any. */
  readonly source?: string;
  readonly copyMethod?: CopyMethod;
  readonly createdAt: string;
}

type FolderRecord = RunFolderRecord | JudgeFolderRecord;

/** Makes shell commands behave the same in every run and never wait on colors or prompts. */
const COMMAND_ENV = { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } as const;

/**
 * Settings for every git call, so the user's global configuration cannot run hooks, sign
 * commits, write reflogs that would reveal the amend, trigger a background gc, or change the diff
 * format. Passed per call; no git configuration is ever written.
 */
const GIT_SETTINGS = [
  'core.hooksPath=/dev/null',
  'commit.gpgSign=false',
  'core.logAllRefUpdates=false',
  'gc.auto=0',
  'advice.detachedHead=false',
  'init.defaultBranch=main',
  'diff.noprefix=false',
  'diff.mnemonicPrefix=false',
].flatMap((setting) => ['-c', setting]);

/** Root configuration-surface paths, removed from judge copies even when git ignores them. */
const ROOT_CONFIGURATION_SURFACE = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  '.claude',
  '.mcp.json',
];

const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * `Executor` on the local filesystem with git.
 *
 * Layout under `root`:
 * - `snapshots/<commit>-<setup hash>/`: the sealed repo; `snapshots/<id>.json` marks it complete.
 * - `folders/<run folder id>/`: one run folder; `folders/<id>.json` records its snapshot, base
 *   commit and copy method.
 * - `folders/<judge folder id>/`: one judge folder; `folders/<id>.json` records it as such.
 *
 * Marker and record sit next to their directory, not inside, so they never enter a commit or the
 * agent's view.
 */
export class LocalExecutor implements Executor {
  readonly root: string;

  private readonly clock: Clock;
  private readonly run: ProcessRunner;
  private readonly platform: NodeJS.Platform;
  private readonly placeboVersion: string | undefined;
  private readonly newId: () => string;
  private readonly building = new Map<string, Promise<void>>();

  constructor(options: LocalExecutorOptions = {}) {
    this.root = resolve(options.root ?? '.placebo');
    this.clock = options.clock ?? systemClock;
    this.run = options.run ?? spawnProcess;
    this.platform = options.platform ?? process.platform;
    this.placeboVersion = options.placeboVersion;
    this.newId = options.newId ?? randomUUID;
  }

  private get snapshotsDir(): string {
    return join(this.root, 'snapshots');
  }

  private get foldersDir(): string {
    return join(this.root, 'folders');
  }

  async prepareSnapshot(input: {
    readonly repo: string;
    readonly commit: string;
    readonly setup?: string;
  }): Promise<Snapshot> {
    const setupHash = sha256(input.setup ?? '').slice(0, 12);
    const given = input.commit.toLowerCase();
    if (FULL_COMMIT.test(given)) {
      const cached = this.snapshotAt(given as CommitSha, setupHash);
      if (await exists(this.markerPath(cached.id))) return cached;
    }
    const source = await sourceOf(input.repo);
    const commit = await this.resolveCommit(source, input.commit);
    const snapshot = this.snapshotAt(commit, setupHash);
    if (await exists(this.markerPath(snapshot.id))) return snapshot;

    let pending = this.building.get(snapshot.id);
    if (pending === undefined) {
      pending = this.buildSnapshot(source, snapshot, input.setup).finally(() =>
        this.building.delete(snapshot.id),
      );
      this.building.set(snapshot.id, pending);
    }
    await pending;
    return snapshot;
  }

  async createRunFolder(snapshot: Snapshot, patch?: string): Promise<RunFolder> {
    const variantPatch = patch !== undefined && patch.trim() !== '' ? patch : undefined;
    if (variantPatch !== undefined) {
      const suitePaths = patchPaths(variantPatch).filter(
        (path) => path === '.placebo' || path.startsWith('.placebo/'),
      );
      if (suitePaths.length > 0) {
        throw new ExecutorError(
          'patch_rejected',
          `variant patch touches .placebo/ (${suitePaths.join(', ')}); the suite never enters a run folder (ADR 0011)`,
        );
      }
    }

    const id = this.newId();
    const path = join(this.foldersDir, id);
    const recordPath = `${path}.json`;
    await mkdir(this.foldersDir, { recursive: true });
    try {
      const copyMethod = await this.copyTree(snapshot.path, path);
      if (variantPatch !== undefined) await this.applyPatch(path, variantPatch);
      await this.amendKeepingIdentity(path);
      await this.expectOneCommit(path);
      const record: RunFolderRecord = {
        kind: 'run',
        snapshotId: snapshot.id,
        baseCommit: (await this.git(path, ['rev-parse', 'HEAD'])).trim(),
        copyMethod,
        createdAt: this.clock.now().toISOString(),
      };
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      return { path, snapshotId: snapshot.id, copyMethod };
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      await rm(recordPath, { force: true });
      throw error;
    }
  }

  async computeChange(runFolder: RunFolder): Promise<Change> {
    const cwd = runFolder.path;
    const base = await this.baseCommit(runFolder);
    // A private copy of the index: `git add -A` includes untracked files without touching the
    // index the agent left, so `git status` reads the same before and after.
    const scratch = await mkdtemp(join(tmpdir(), 'placebo-index-'));
    try {
      const index = join(scratch, 'index');
      const gitIndex = resolve(
        cwd,
        (await this.git(cwd, ['rev-parse', '--git-path', 'index'])).trim(),
      );
      if (await exists(gitIndex)) await copyFile(gitIndex, index);
      const env = { GIT_INDEX_FILE: index };
      await this.git(cwd, ['add', '-A'], { env });
      const diff = await this.git(
        cwd,
        ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', base],
        { env },
      );
      const names = await this.git(
        cwd,
        ['diff', '--cached', '--name-only', '--no-renames', '-z', base],
        { env },
      );
      const files = names
        .split('\0')
        .filter((name) => name !== '')
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return { diff, files, bytes: Buffer.byteLength(diff, 'utf8') };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async injectHidden(runFolder: RunFolder, files: readonly HiddenFile[]): Promise<void> {
    const root = await realpath(runFolder.path);
    const targets = files.map((file) => {
      const destination = resolve(root, file.path);
      if (isAbsolute(file.path) || !isInside(root, destination)) {
        throw new ExecutorError(
          'path_escapes_run_folder',
          `hidden file path ${file.path} escapes the run folder`,
        );
      }
      return { destination, content: file.content };
    });
    for (const { destination, content } of targets) {
      // Resolve symlinks the agent may have left, so a link cannot redirect a write outside.
      await this.expectRealPathInside(root, await nearestExisting(dirname(destination)));
      await mkdir(dirname(destination), { recursive: true });
      await this.expectRealPathInside(root, dirname(destination));
      await rm(destination, { force: true });
      await writeFile(destination, content);
    }
  }

  async exec(runFolder: RunFolder, command: string): Promise<ExecResult> {
    return this.shell(runFolder.path, command);
  }

  async createJudgeFolder(runFolder?: RunFolder): Promise<RunFolder> {
    const path = join(this.foldersDir, this.newId());
    const recordPath = `${path}.json`;
    await mkdir(this.foldersDir, { recursive: true });
    try {
      let folder: RunFolder;
      let record: JudgeFolderRecord;
      const createdAt = this.clock.now().toISOString();
      if (runFolder === undefined) {
        await mkdir(path);
        folder = { path, snapshotId: '' };
        record = { kind: 'judge', snapshotId: '', createdAt };
      } else {
        const copyMethod = await this.copyTree(resolve(runFolder.path), path);
        await this.stripConfigurationSurface(path);
        folder = { path, snapshotId: runFolder.snapshotId, copyMethod };
        record = {
          kind: 'judge',
          snapshotId: runFolder.snapshotId,
          source: resolve(runFolder.path),
          copyMethod,
          createdAt,
        };
      }
      await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
      return folder;
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      await rm(recordPath, { force: true });
      throw error;
    }
  }

  async remove(runFolder: RunFolder): Promise<void> {
    const path = resolve(runFolder.path);
    if (dirname(path) !== this.foldersDir) {
      throw new Error(`refusing to remove ${path}: not a run folder under ${this.foldersDir}`);
    }
    await rm(path, { recursive: true, force: true });
    await rm(`${path}.json`, { force: true });
  }

  async listRunFolders(): Promise<RunFolder[]> {
    const names = await directoriesIn(this.foldersDir);
    return Promise.all(
      names.map(async (name) => {
        const path = join(this.foldersDir, name);
        const record = await readJson<FolderRecord>(`${path}.json`);
        if (record?.kind === 'judge') return undefined;
        const folder: RunFolder =
          record === undefined
            ? { path, snapshotId: '' }
            : { path, snapshotId: record.snapshotId, copyMethod: record.copyMethod };
        return folder;
      }),
    ).then((folders) => folders.filter((folder) => folder !== undefined));
  }

  /** Complete snapshots, by id. Incomplete directories are left out. */
  async listSnapshots(): Promise<Snapshot[]> {
    const names = await directoriesIn(this.snapshotsDir);
    const snapshots: Snapshot[] = [];
    for (const id of names) {
      const marker = await readJson<SnapshotMarker>(this.markerPath(id));
      if (marker !== undefined) {
        snapshots.push({
          id,
          path: join(this.snapshotsDir, id),
          commit: marker.commit as CommitSha,
        });
      }
    }
    return snapshots;
  }

  /** Deletes the given snapshots, or every snapshot (complete or not) when `ids` is omitted. */
  async removeSnapshots(ids?: readonly string[]): Promise<void> {
    if (ids === undefined) {
      await rm(this.snapshotsDir, { recursive: true, force: true });
      return;
    }
    for (const id of ids) {
      if (id.includes('/') || id.includes(sep) || id === '' || id.startsWith('.')) {
        throw new Error(`invalid snapshot id ${id}`);
      }
      await rm(this.markerPath(id), { force: true });
      await rm(join(this.snapshotsDir, id), { recursive: true, force: true });
    }
  }

  private snapshotAt(commit: CommitSha, setupHash: string): Snapshot {
    const id = `${commit}-${setupHash}`;
    return { id, path: join(this.snapshotsDir, id), commit };
  }

  private markerPath(id: string): string {
    return join(this.snapshotsDir, `${id}.json`);
  }

  private async resolveCommit(source: Source, commit: string): Promise<CommitSha> {
    if (commit.startsWith('-') || commit.trim() === '') {
      throw new ExecutorError('commit_not_found', `invalid commit "${commit}"`);
    }
    if (source.kind === 'path') {
      const out = await this.run(
        'git',
        [...GIT_SETTINGS, 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`],
        { cwd: source.location },
      );
      if (out.exitCode === 1) {
        throw new ExecutorError(
          'commit_not_found',
          `commit ${commit} does not exist in ${source.location}`,
          out,
        );
      }
      if (out.exitCode !== 0) {
        throw new ExecutorError(
          'clone_failed',
          `cannot read ${source.location} as a git repository: ${out.stderr.trim()}`,
          out,
        );
      }
      return out.stdout.trim() as CommitSha;
    }
    const lower = commit.toLowerCase();
    if (FULL_COMMIT.test(lower)) return lower as CommitSha;
    const out = await this.run('git', [...GIT_SETTINGS, 'ls-remote', source.location, commit], {
      cwd: tmpdir(),
    });
    if (out.exitCode !== 0) {
      throw new ExecutorError(
        'clone_failed',
        `cannot list ${source.location}: ${out.stderr.trim()}`,
        out,
      );
    }
    const found = /^([0-9a-f]+)\t/m.exec(out.stdout)?.[1];
    if (found === undefined) {
      throw new ExecutorError(
        'commit_not_found',
        `${commit} is not a full commit id nor a ref of ${source.location}`,
        out,
      );
    }
    return found as CommitSha;
  }

  private async buildSnapshot(
    source: Source,
    snapshot: Snapshot,
    setup: string | undefined,
  ): Promise<void> {
    const cwd = snapshot.path;
    await rm(this.markerPath(snapshot.id), { force: true });
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    try {
      await this.git(cwd, ['init', '-q', '--template=']);
      // A fetch, not a copy: untracked and ignored files of the source never enter.
      await this.git(
        cwd,
        ['fetch', '-q', '--no-tags', '--depth', '1', source.location, snapshot.commit],
        { reason: 'clone_failed' },
      );
      await this.git(cwd, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
      await this.git(cwd, ['checkout', '-q', '-b', 'main']);
      // ADR 0011: the suite never reaches the agent. Every snapshot goes through this amend,
      // which also turns the shallow commit into a root commit.
      await rm(join(cwd, '.placebo'), { recursive: true, force: true });
      await this.amendKeepingIdentity(cwd);

      if (setup !== undefined && setup.trim() !== '') {
        const result = await this.shell(cwd, setup);
        if (result.exitCode !== 0) {
          throw new ExecutorError(
            'setup_failed',
            `setup command failed with ${result.exitCode === null ? 'a signal' : `exit code ${String(result.exitCode)}`}: ${setup}`,
            result,
          );
        }
        // Setup outputs that are not ignored belong to the base, never to the change.
        await this.amendKeepingIdentity(cwd);
      }

      for (const remote of lines(await this.git(cwd, ['remote']))) {
        await this.git(cwd, ['remote', 'remove', remote]);
      }
      await rm(join(cwd, '.git', 'FETCH_HEAD'), { force: true });
      await rm(join(cwd, '.git', 'ORIG_HEAD'), { force: true });
      // Drop the pre-amend commit and its tree (which held `.placebo/`) from the object store.
      await this.git(cwd, ['reflog', 'expire', '--expire=now', '--all']);
      await this.git(cwd, ['gc', '-q', '--prune=now']);
      await rm(join(cwd, '.git', 'shallow'), { force: true });

      await this.expectOneCommit(cwd);
      const remotes = lines(await this.git(cwd, ['remote']));
      if (remotes.length > 0) {
        throw new ExecutorError('git_failed', `snapshot still has remotes: ${remotes.join(', ')}`);
      }
      const marker: SnapshotMarker = {
        commit: snapshot.commit,
        setup: setup ?? null,
        createdAt: this.clock.now().toISOString(),
        ...(this.placeboVersion === undefined ? {} : { placeboVersion: this.placeboVersion }),
      };
      await writeFile(this.markerPath(snapshot.id), `${JSON.stringify(marker, null, 2)}\n`);
    } catch (error) {
      await rm(cwd, { recursive: true, force: true });
      throw error;
    }
  }

  private async copyTree(source: string, destination: string): Promise<CopyMethod> {
    const native: { method: CopyMethod; args: string[] } | undefined =
      this.platform === 'darwin'
        ? { method: 'clonefile', args: ['-Rc', `${source}/.`, `${destination}/`] }
        : this.platform === 'linux'
          ? {
              method: 'reflink_auto',
              args: ['-a', '--reflink=auto', `${source}/.`, `${destination}/`],
            }
          : undefined;
    if (native !== undefined) {
      await mkdir(destination, { recursive: true });
      const out = await this.run('cp', native.args, { cwd: this.root }).catch(
        (): ProcessOutput => ({ exitCode: -1, stdout: '', stderr: 'cp could not start' }),
      );
      if (out.exitCode === 0) return native.method;
      await rm(destination, { recursive: true, force: true });
    }
    try {
      await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    } catch (error) {
      throw new ExecutorError(
        'copy_failed',
        `cannot copy snapshot ${source} to ${destination}: ${String(error)}`,
      );
    }
    return 'node_copy';
  }

  /**
   * Removes every configuration-surface path from a judge's copy: tracked and untracked files
   * (as git lists them) matching the surface, the root surface files even when ignored, and every
   * `.claude/` directory found by walking, since directories are not files.
   */
  private async stripConfigurationSurface(cwd: string): Promise<void> {
    const listed = [
      ...(await this.git(cwd, ['ls-files', '-z'])).split('\0'),
      ...(await this.git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'])).split('\0'),
    ];
    const paths = new Set([
      ...ROOT_CONFIGURATION_SURFACE,
      ...listed.filter(isConfigurationSurface),
    ]);
    for (const path of paths) await rm(join(cwd, path), { recursive: true, force: true });
    for (const dir of await claudeDirectories(cwd)) await rm(dir, { recursive: true, force: true });
  }

  private async applyPatch(cwd: string, patch: string): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), 'placebo-patch-'));
    try {
      const file = join(scratch, 'variant.patch');
      await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`);
      await this.git(cwd, ['apply', '--whitespace=nowarn', file], { reason: 'patch_failed' });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * `git add -A && git commit --amend --no-edit` keeping the author, committer, dates and message
   * exactly (ADR 0012), without relying on any configured git identity.
   */
  private async amendKeepingIdentity(cwd: string): Promise<void> {
    const [authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = (
      await this.git(cwd, ['log', '-1', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI'])
    ).split('\n');
    await this.git(cwd, ['add', '-A']);
    await this.git(
      cwd,
      [
        'commit',
        '-q',
        '--amend',
        '--no-edit',
        '--allow-empty',
        '--no-verify',
        '--cleanup=verbatim',
      ],
      {
        env: {
          GIT_AUTHOR_NAME: authorName ?? '',
          GIT_AUTHOR_EMAIL: authorEmail ?? '',
          GIT_AUTHOR_DATE: authorDate ?? '',
          GIT_COMMITTER_NAME: committerName ?? '',
          GIT_COMMITTER_EMAIL: committerEmail ?? '',
          GIT_COMMITTER_DATE: committerDate ?? '',
        },
      },
    );
  }

  private async expectOneCommit(cwd: string): Promise<void> {
    const count = (await this.git(cwd, ['rev-list', '--all', '--count'])).trim();
    if (count !== '1') {
      throw new ExecutorError(
        'git_failed',
        `expected exactly one reachable commit in ${cwd}, found ${count}`,
      );
    }
  }

  private async baseCommit(runFolder: RunFolder): Promise<string> {
    const record = await readJson<FolderRecord>(`${resolve(runFolder.path)}.json`);
    if (record?.kind === 'run') return record.baseCommit;
    // Without a record the base is the root commit: the run folder starts with exactly one.
    const roots = lines(await this.git(runFolder.path, ['rev-list', '--max-parents=0', 'HEAD']));
    return roots.at(-1) ?? 'HEAD';
  }

  private async expectRealPathInside(root: string, path: string): Promise<void> {
    if (!isInside(root, await realpath(path), true)) {
      throw new ExecutorError(
        'path_escapes_run_folder',
        `${path} resolves outside the run folder through a symbolic link`,
      );
    }
  }

  private async shell(cwd: string, command: string): Promise<ExecResult> {
    const started = this.clock.now().getTime();
    const out = await this.run('sh', ['-c', command], { cwd, env: COMMAND_ENV });
    return { ...out, durationMs: this.clock.now().getTime() - started };
  }

  private async git(
    cwd: string,
    args: readonly string[],
    options: { readonly reason?: ExecutorErrorReason; readonly env?: Record<string, string> } = {},
  ): Promise<string> {
    // Snapshots and run folders sit inside the user's repo: never let git walk up into it.
    const out = await this.run('git', [...GIT_SETTINGS, ...args], {
      cwd,
      env: { GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)), ...options.env },
    });
    if (out.exitCode !== 0) {
      throw new ExecutorError(
        options.reason ?? 'git_failed',
        `git ${args.join(' ')} failed in ${cwd}: ${out.stderr.trim()}`,
        out,
      );
    }
    return out.stdout;
  }
}

interface Source {
  readonly kind: 'path' | 'url';
  /** Absolute path for a local repo, or the URL as given. */
  readonly location: string;
}

async function sourceOf(repo: string): Promise<Source> {
  if (repo.startsWith('-')) throw new ExecutorError('clone_failed', `invalid repo "${repo}"`);
  const path = resolve(repo);
  const info = await stat(path).catch(() => undefined);
  return info?.isDirectory() === true
    ? { kind: 'path', location: path }
    : { kind: 'url', location: repo };
}

/** True when `path` is `root` itself (if allowed) or strictly below it. */
function isInside(root: string, path: string, allowRoot = false): boolean {
  const rel = relative(root, path);
  if (rel === '') return allowRoot;
  return !rel.startsWith('..') && !isAbsolute(rel);
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  while (!(await exists(current))) current = dirname(current);
  return current;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Every `.claude` directory under `root`, outside `.git`, without following symbolic links. */
async function claudeDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      if (entry.name === '.claude') found.push(path);
      else if (!(dir === root && entry.name === '.git')) pending.push(path);
    }
  }
  return found;
}

async function directoriesIn(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}
