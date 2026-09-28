import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Clock } from '../../kernel/clock.js';
import type { Snapshot } from '../../ports/executor.js';
import { ExecutorError } from './executor-error.js';
import { LocalExecutor, type LocalExecutorOptions } from './local-executor.js';
import { spawnProcess, type ProcessRunner } from './process.js';

const TIMEOUT = 60_000;
const clock: Clock = { now: () => new Date('2026-09-27T10:00:00.000Z') };

/** Test git never reads the developer's configuration. */
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Author',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Cy Committer',
  GIT_COMMITTER_EMAIL: 'cy@example.com',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...TEST_GIT_ENV, ...env }, encoding: 'utf8' });
}

function commitAt(cwd: string, message: string, day: number): void {
  const date = `2020-01-0${String(day)}T12:00:00+02:00`;
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: `2020-01-0${String(day)}T13:30:00-05:00`,
  });
}

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function rejection(promise: Promise<unknown>): Promise<ExecutorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExecutorError) return error;
    throw error;
  }
  throw new Error('expected an ExecutorError');
}

const META = '%an|%ae|%aI|%cn|%ce|%cI|%B';

let temp: string;
let source: string;
let commits: string[];
let root: string;

/** Source repo: 3 commits, a `.placebo/` suite, an untracked secret and ignored node_modules. */
beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-executor-test-')));
  source = join(temp, 'source');
  root = join(temp, 'placebo-root');
  await mkdir(source);
  git(source, ['init', '-q', '-b', 'trunk']);
  await put(source, {
    '.gitignore': 'node_modules/\ndist/\n',
    'CLAUDE.md': '# Rules\nuse tabs\n',
    'README.md': 'readme\n',
    'src/a.ts': 'one\n',
    '.placebo/suite.yaml': 'tasks: []\n',
    '.placebo/tasks/fix/hidden/answer.test.ts': 'expect(fix()).toBe(42) // HIDDEN-ANSWER\n',
  });
  commitAt(source, 'first commit\n\nwith a body line', 1);
  await put(source, { 'src/a.ts': 'two\n' });
  commitAt(source, 'second commit', 2);
  await put(source, { 'src/a.ts': 'three\n', 'src/b.ts': 'bee\n' });
  commitAt(source, 'third commit\n\nbody of the third', 3);
  commits = git(source, ['rev-list', 'HEAD']).trim().split('\n').reverse();
  await put(source, {
    'secret.env': 'TOKEN=untracked-secret\n',
    'node_modules/pkg/index.js': 'ignored\n',
  });
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function executor(options: Omit<LocalExecutorOptions, 'root' | 'clock'> = {}): LocalExecutor {
  let next = 0;
  return new LocalExecutor({
    root,
    clock,
    placeboVersion: '0.0.0-test',
    newId: () => `run-${String(++next)}`,
    ...options,
  });
}

function recordingRunner(): { run: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (file, args, options) => {
      calls.push([file, ...args]);
      return spawnProcess(file, args, options);
    },
  };
}

/** A patch against the third commit, made in a scratch clone. */
async function makePatch(
  edit: (dir: string) => Promise<void>,
  extraArgs: string[] = [],
): Promise<string> {
  const dir = join(temp, `patch-${String(Math.random()).slice(2)}`);
  git(temp, ['clone', '-q', source, dir]);
  await edit(dir);
  git(dir, ['add', '-A']);
  return git(dir, ['diff', '--cached', 'HEAD', ...extraArgs]);
}

describe('LocalExecutor.prepareSnapshot', () => {
  it(
    'seals the pinned commit: one commit, no remotes, no suite, no untracked files',
    async () => {
      const snapshot = await executor().prepareSnapshot({ repo: source, commit: 'trunk' });
      const head = commits[2]!;
      expect(snapshot.commit).toBe(head);
      expect(snapshot.id).toMatch(new RegExp(`^${head}-[0-9a-f]{12}$`));
      expect(snapshot.path).toBe(join(root, 'snapshots', snapshot.id));
      expect(snapshot.cached).toBe(false);

      const cwd = snapshot.path;
      expect(git(cwd, ['rev-list', '--all', '--count']).trim()).toBe('1');
      expect(git(cwd, ['remote']).trim()).toBe('');
      expect(git(cwd, ['branch', '--show-current']).trim()).toBe('main');
      expect(git(cwd, ['status', '--porcelain']).trim()).toBe('');
      expect(await exists(join(cwd, '.placebo'))).toBe(false);
      expect(await exists(join(cwd, 'secret.env'))).toBe(false);
      expect(await exists(join(cwd, 'node_modules'))).toBe(false);
      expect(await exists(join(cwd, '.git', 'shallow'))).toBe(false);
      expect(await exists(join(cwd, '.git', 'FETCH_HEAD'))).toBe(false);
      expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# Rules\nuse tabs\n');
      expect(await readFile(join(cwd, 'src/b.ts'), 'utf8')).toBe('bee\n');
      expect(git(cwd, ['log', '-1', `--format=${META}`])).toBe(
        git(source, ['log', '-1', `--format=${META}`, head]),
      );
      expect(git(cwd, ['log', '-1', '--format=%P']).trim()).toBe('');
      // The pre-amend tree with the suite is gone from the object store, not only unreachable.
      const all = git(cwd, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);
      const reachable = git(cwd, ['rev-list', '--all', '--objects']);
      expect(all.trim().split('\n').length).toBe(reachable.trim().split('\n').length);

      const marker = JSON.parse(
        await readFile(join(root, 'snapshots', `${snapshot.id}.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(marker).toEqual({
        commit: head,
        setup: null,
        createdAt: '2026-09-27T10:00:00.000Z',
        placeboVersion: '0.0.0-test',
      });
    },
    TIMEOUT,
  );

  it(
    'pins an older commit given as a short id',
    async () => {
      const first = commits[0]!;
      const snapshot = await executor().prepareSnapshot({
        repo: source,
        commit: first.slice(0, 8),
      });
      expect(snapshot.commit).toBe(first);
      expect(await readFile(join(snapshot.path, 'src/a.ts'), 'utf8')).toBe('one\n');
      expect(await exists(join(snapshot.path, 'src/b.ts'))).toBe(false);
      expect(git(snapshot.path, ['log', '-1', '--format=%B'])).toBe(
        'first commit\n\nwith a body line\n\n',
      );
    },
    TIMEOUT,
  );

  it('fails with commit_not_found for an unknown commit', async () => {
    const error = await rejection(executor().prepareSnapshot({ repo: source, commit: 'deadbeef' }));
    expect(error.reason).toBe('commit_not_found');
    expect(
      (await rejection(executor().prepareSnapshot({ repo: source, commit: '--all' }))).reason,
    ).toBe('commit_not_found');
  });

  it('fails with clone_failed when the repo is not a git repository', async () => {
    const plain = join(temp, 'plain');
    await mkdir(plain);
    const error = await rejection(executor().prepareSnapshot({ repo: plain, commit: 'HEAD' }));
    expect(error.reason).toBe('clone_failed');
    expect(
      (await rejection(executor().prepareSnapshot({ repo: '-x', commit: 'HEAD' }))).reason,
    ).toBe('clone_failed');
  });

  it(
    'passes URLs through to git',
    async () => {
      const url = `file://${source}`;
      const byRef = await executor().prepareSnapshot({ repo: url, commit: 'trunk' });
      expect(byRef.commit).toBe(commits[2]);
      const byId = await executor().prepareSnapshot({
        repo: url,
        commit: commits[1]!.toUpperCase(),
      });
      expect(byId.commit).toBe(commits[1]);
      expect(await readFile(join(byId.path, 'src/a.ts'), 'utf8')).toBe('two\n');
      expect(
        (await rejection(executor().prepareSnapshot({ repo: url, commit: 'nope' }))).reason,
      ).toBe('commit_not_found');
      const missing = `file://${join(temp, 'missing')}`;
      expect(
        (await rejection(executor().prepareSnapshot({ repo: missing, commit: 'trunk' }))).reason,
      ).toBe('clone_failed');
      expect(
        (await rejection(executor().prepareSnapshot({ repo: missing, commit: commits[0]! })))
          .reason,
      ).toBe('clone_failed');
      const left = await readdir(join(root, 'snapshots'));
      expect(left.filter((name) => name.startsWith(commits[0]!))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'returns a cached snapshot without running git, and rebuilds an incomplete one',
    async () => {
      const first = await executor().prepareSnapshot({ repo: source, commit: 'trunk' });
      expect(first.cached).toBe(false);
      const inode = (await stat(join(first.path, '.git'))).ino;

      const spy = recordingRunner();
      const cached = await executor({ run: spy.run }).prepareSnapshot({
        repo: source,
        commit: first.commit,
      });
      expect(cached).toEqual({ ...first, cached: true });
      expect(spy.calls).toEqual([]);

      const byRef = await executor({ run: spy.run }).prepareSnapshot({
        repo: source,
        commit: 'trunk',
      });
      expect(byRef.cached).toBe(true);
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]).toContain('rev-parse');
      expect((await stat(join(first.path, '.git'))).ino).toBe(inode);

      await rm(join(root, 'snapshots', `${first.id}.json`));
      await writeFile(join(first.path, 'leftover.txt'), 'half-built');
      const rebuilt = await executor().prepareSnapshot({ repo: source, commit: first.commit });
      expect(rebuilt).toEqual(first);
      expect(rebuilt.cached).toBe(false);
      expect(await exists(join(first.path, 'leftover.txt'))).toBe(false);
      expect(await exists(join(root, 'snapshots', `${first.id}.json`))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'shares one build between concurrent calls',
    async () => {
      const spy = recordingRunner();
      const shared = executor({ run: spy.run });
      const [a, b] = await Promise.all([
        shared.prepareSnapshot({ repo: source, commit: 'trunk' }),
        shared.prepareSnapshot({ repo: source, commit: 'trunk' }),
      ]);
      expect(a).toEqual(b);
      expect(spy.calls.filter((call) => call.includes('fetch'))).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'runs setup once and folds its non-ignored output into the single commit',
    async () => {
      const counter = join(temp, 'setup-count');
      const setup = `echo run >> ${counter} && echo "$CI$FORCE_COLOR$NO_COLOR" > built.txt && mkdir -p node_modules/dep && echo x > node_modules/dep/index.js`;
      const one = await executor().prepareSnapshot({ repo: source, commit: 'trunk', setup });
      const two = await executor().prepareSnapshot({ repo: source, commit: 'trunk', setup });
      expect(two).toEqual({ ...one, cached: true });
      expect(await readFile(counter, 'utf8')).toBe('run\n');
      expect(await readFile(join(one.path, 'built.txt'), 'utf8')).toBe('101\n');
      expect(git(one.path, ['ls-files'])).toContain('built.txt');
      expect(git(one.path, ['ls-files'])).not.toContain('node_modules');
      expect(await exists(join(one.path, 'node_modules/dep/index.js'))).toBe(true);
      expect(git(one.path, ['status', '--porcelain']).trim()).toBe('');
      expect(git(one.path, ['rev-list', '--all', '--count']).trim()).toBe('1');
      expect(git(one.path, ['log', '-1', `--format=${META}`])).toBe(
        git(source, ['log', '-1', `--format=${META}`, commits[2]!]),
      );

      const plain = await executor().prepareSnapshot({ repo: source, commit: 'trunk' });
      expect(plain.id).not.toBe(one.id);
      expect(plain.id.slice(0, 40)).toBe(one.id.slice(0, 40));
    },
    TIMEOUT,
  );

  it(
    'removes the directory and reports output when setup fails',
    async () => {
      const error = await rejection(
        executor().prepareSnapshot({
          repo: source,
          commit: 'trunk',
          setup: 'echo progress; echo broken dependency >&2; exit 3',
        }),
      );
      expect(error.reason).toBe('setup_failed');
      expect(error.message).toContain('exit code 3');
      expect(error.stdout).toBe('progress\n');
      expect(error.stderr).toBe('broken dependency\n');
      expect(await readdir(join(root, 'snapshots'))).toEqual([]);

      const killed = await rejection(
        executor().prepareSnapshot({ repo: source, commit: 'trunk', setup: 'kill -9 $$' }),
      );
      expect(killed.message).toContain('a signal');
    },
    TIMEOUT,
  );

  it('lists and removes snapshots', { timeout: TIMEOUT }, async () => {
    const ex = executor();
    const a = await ex.prepareSnapshot({ repo: source, commit: 'trunk' });
    const b = await ex.prepareSnapshot({ repo: source, commit: 'trunk~1' });
    await mkdir(join(root, 'snapshots', 'incomplete'));
    expect((await ex.listSnapshots()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    await ex.removeSnapshots([a.id]);
    expect(await ex.listSnapshots()).toEqual([{ ...b, cached: true }]);
    expect(await exists(a.path)).toBe(false);
    await expect(ex.removeSnapshots(['../x'])).rejects.toThrow('invalid snapshot id');
    await ex.removeSnapshots();
    expect(await ex.listSnapshots()).toEqual([]);
  });
});

describe('LocalExecutor run folders', () => {
  let ex: LocalExecutor;
  let snapshot: Snapshot;

  beforeEach(async () => {
    ex = executor();
    snapshot = await ex.prepareSnapshot({ repo: source, commit: 'trunk' });
  }, TIMEOUT);

  const variant = (): Promise<string> =>
    makePatch(async (dir) => {
      await put(dir, {
        'CLAUDE.md': '# Rules\nuse spaces\n',
        '.claude/rules/style.md': 'be brief\n',
      });
      await rm(join(dir, 'src/b.ts'));
    });

  it(
    'applies the variant patch and amends it into the single commit',
    async () => {
      const folder = await ex.createRunFolder(snapshot, await variant());
      expect(folder).toMatchObject({
        path: join(root, 'folders', 'run-1'),
        snapshotId: snapshot.id,
      });
      const cwd = folder.path;
      expect(await readFile(join(cwd, 'CLAUDE.md'), 'utf8')).toBe('# Rules\nuse spaces\n');
      expect(await readFile(join(cwd, '.claude/rules/style.md'), 'utf8')).toBe('be brief\n');
      expect(await exists(join(cwd, 'src/b.ts'))).toBe(false);
      expect(git(cwd, ['rev-list', '--all', '--count']).trim()).toBe('1');
      expect(git(cwd, ['status', '--porcelain']).trim()).toBe('');
      expect(git(cwd, ['log', '-1', `--format=${META}`])).toBe(
        git(snapshot.path, ['log', '-1', `--format=${META}`]),
      );
      expect(git(cwd, ['rev-parse', 'HEAD'])).not.toBe(git(snapshot.path, ['rev-parse', 'HEAD']));
      expect(git(cwd, ['reflog']).trim()).toBe('');
      if (process.platform === 'darwin') expect(folder.copyMethod).toBe('clonefile');
      expect(await ex.listRunFolders()).toEqual([folder]);
    },
    TIMEOUT,
  );

  it(
    'amends the control arm too, leaving the snapshot commit unchanged',
    async () => {
      const control = await ex.createRunFolder(snapshot);
      const blank = await ex.createRunFolder(snapshot, '  \n');
      const head = git(snapshot.path, ['rev-parse', 'HEAD']);
      expect(git(control.path, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(blank.path, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(control.path, ['rev-list', '--all', '--count']).trim()).toBe('1');
    },
    TIMEOUT,
  );

  it('rejects a patch touching .placebo/ before copying anything', async () => {
    const patch = await makePatch((dir) => put(dir, { '.placebo/suite.yaml': 'tasks: [x]\n' }));
    const error = await rejection(ex.createRunFolder(snapshot, patch));
    expect(error.reason).toBe('patch_rejected');
    expect(error.message).toContain('.placebo/suite.yaml');
    expect(await ex.listRunFolders()).toEqual([]);
  });

  it(
    'removes the folder and reports git when the patch does not apply',
    async () => {
      const malformed =
        'diff --git a/CLAUDE.md b/CLAUDE.md\n--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1,1 +1,1 @@\n-not in the file\n+x';
      const error = await rejection(ex.createRunFolder(snapshot, malformed));
      expect(error.reason).toBe('patch_failed');
      expect(error.stderr).toContain('CLAUDE.md');
      expect(await ex.listRunFolders()).toEqual([]);
      expect(await readdir(join(root, 'folders'))).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'computes only the agent change, including untracked files, deletions and binaries',
    async () => {
      const folder = await ex.createRunFolder(snapshot, await variant());
      const cwd = folder.path;
      await put(cwd, {
        'src/a.ts': 'three\nfixed\n',
        'src/new.ts': 'export const n = 1;\n',
        'node_modules/junk/index.js': 'ignored\n',
        'dist/out.js': 'ignored\n',
      });
      await writeFile(join(cwd, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
      await rm(join(cwd, 'README.md'));
      git(cwd, ['add', 'src/a.ts']);
      const statusBefore = git(cwd, ['status', '--porcelain']);

      const change = await ex.computeChange(folder);
      expect(change.files).toEqual(['README.md', 'logo.bin', 'src/a.ts', 'src/new.ts']);
      expect(change.diff).toContain('+fixed');
      expect(change.diff).toContain('deleted file mode');
      expect(change.diff).toContain('Binary files /dev/null and b/logo.bin differ');
      expect(change.diff).not.toContain('style.md');
      expect(change.diff).not.toContain('CLAUDE.md');
      expect(change.diff).not.toContain('node_modules');
      expect(change.bytes).toBe(Buffer.byteLength(change.diff, 'utf8'));
      expect(git(cwd, ['status', '--porcelain'])).toBe(statusBefore);
    },
    TIMEOUT,
  );

  it(
    'counts committed agent work and non-ASCII bytes, with or without the record',
    async () => {
      const folder = await ex.createRunFolder(snapshot);
      await put(folder.path, { 'src/é.ts': 'café\n' });
      git(folder.path, ['add', '-A']);
      git(folder.path, ['commit', '-q', '-m', 'agent commit']);
      const change = await ex.computeChange(folder);
      expect(change.files).toEqual(['src/é.ts']);
      expect(change.bytes).toBeGreaterThan(change.diff.length);

      await rm(`${folder.path}.json`);
      expect(await ex.computeChange(folder)).toEqual(change);
      expect(await ex.listRunFolders()).toEqual([{ path: folder.path, snapshotId: '' }]);
    },
    TIMEOUT,
  );

  it('returns an empty change for an untouched run folder', { timeout: TIMEOUT }, async () => {
    const folder = await ex.createRunFolder(snapshot);
    await rm(join(folder.path, '.git', 'index'));
    expect(await ex.computeChange(folder)).toEqual({ diff: '', files: [], bytes: 0 });
  });

  it('fails with git_failed outside a repository', async () => {
    const plain = join(temp, 'not-a-repo');
    await mkdir(plain);
    const error = await rejection(ex.computeChange({ path: plain, snapshotId: 'x' }));
    expect(error.reason).toBe('git_failed');
  });

  it(
    'never reaches the user repo that holds the default .placebo root',
    async () => {
      const inside = new LocalExecutor({ root: join(source, '.placebo'), clock });
      const snap = await inside.prepareSnapshot({ repo: source, commit: 'trunk' });
      const folder = await inside.createRunFolder(snap);
      await rm(join(folder.path, '.git'), { recursive: true });
      await rm(`${folder.path}.json`);
      const error = await rejection(inside.computeChange(folder));
      expect(error.reason).toBe('git_failed');
    },
    TIMEOUT,
  );

  it(
    'injects hidden files and rejects paths escaping the run folder',
    { timeout: TIMEOUT },
    async () => {
      const folder = await ex.createRunFolder(snapshot);
      await ex.injectHidden(folder, [
        { path: 'tests/hidden/answer.test.ts', content: 'hidden\n' },
        { path: 'src/a.ts', content: new TextEncoder().encode('overwritten\n') },
      ]);
      expect(await readFile(join(folder.path, 'tests/hidden/answer.test.ts'), 'utf8')).toBe(
        'hidden\n',
      );
      expect(await readFile(join(folder.path, 'src/a.ts'), 'utf8')).toBe('overwritten\n');

      for (const path of ['../outside.txt', '/tmp/absolute.txt', 'a/../../outside.txt', '.']) {
        const error = await rejection(ex.injectHidden(folder, [{ path, content: 'x' }]));
        expect(error.reason, path).toBe('path_escapes_run_folder');
      }
      expect(await exists(join(root, 'folders', 'outside.txt'))).toBe(false);

      const outside = join(temp, 'outside');
      await mkdir(outside);
      await symlink(outside, join(folder.path, 'link'));
      for (const path of ['link/x.txt', 'link/deep/x.txt']) {
        const error = await rejection(ex.injectHidden(folder, [{ path, content: 'x' }]));
        expect(error.reason, path).toBe('path_escapes_run_folder');
      }
      expect(await readdir(outside)).toEqual([]);

      await symlink(join(outside, 'target.txt'), join(folder.path, 'file-link.txt'));
      await ex.injectHidden(folder, [{ path: 'file-link.txt', content: 'replaced link' }]);
      expect(await readFile(join(folder.path, 'file-link.txt'), 'utf8')).toBe('replaced link');
      expect(await exists(join(outside, 'target.txt'))).toBe(false);
    },
  );

  it(
    'runs commands with a shell and captures exit code and both streams',
    { timeout: TIMEOUT },
    async () => {
      const folder = await ex.createRunFolder(snapshot);
      const result = await ex.exec(
        folder,
        'cat src/a.ts; echo "$CI$FORCE_COLOR$NO_COLOR" >&2; exit 4',
      );
      expect(result).toEqual({ exitCode: 4, stdout: 'three\n', stderr: '101\n', durationMs: 0 });
      const killed = await ex.exec(folder, 'kill -9 $$');
      expect(killed.exitCode).toBeNull();
      const big = await ex.exec(folder, 'yes line | head -n 200000');
      expect(big.stdout.length).toBe(200000 * 5);
    },
  );

  it('lists and removes run folders', { timeout: TIMEOUT }, async () => {
    const one = await ex.createRunFolder(snapshot);
    const two = await ex.createRunFolder(snapshot);
    expect(await ex.listRunFolders()).toEqual([one, two]);
    await ex.remove(one);
    expect(await ex.listRunFolders()).toEqual([two]);
    expect(await exists(`${one.path}.json`)).toBe(false);
    await expect(ex.remove({ path: snapshot.path, snapshotId: snapshot.id })).rejects.toThrow(
      'not a run folder',
    );
    expect(await exists(snapshot.path)).toBe(true);
  });

  it('creates an empty judge folder that is not listed and can be removed', async () => {
    await mkdir(root, { recursive: true });
    const judge = await ex.createJudgeFolder();
    expect(judge).toEqual({ path: join(root, 'folders', 'run-1'), snapshotId: '' });
    expect(await readdir(judge.path)).toEqual([]);
    expect(JSON.parse(await readFile(`${judge.path}.json`, 'utf8'))).toMatchObject({
      kind: 'judge',
    });
    expect(await ex.listRunFolders()).toEqual([]);
    await ex.remove(judge);
    expect(await exists(judge.path)).toBe(false);
    expect(await exists(`${judge.path}.json`)).toBe(false);
  });

  it(
    'copies a run folder for a judge without any configuration surface',
    { timeout: TIMEOUT },
    async () => {
      const folder = await ex.createRunFolder(snapshot, await variant());
      await put(folder.path, {
        'src/a.ts': 'three\nfixed by the agent\n',
        'src/new.ts': 'new\n',
        'CLAUDE.local.md': 'local\n',
        'AGENTS.md': 'agents\n',
        '.mcp.json': '{}\n',
        'packages/x/CLAUDE.md': 'nested\n',
        'packages/x/AGENTS.md': 'nested\n',
        'packages/x/.claude/settings.json': '{}\n',
        'packages/x/keep.md': 'keep\n',
        'node_modules/pkg/.claude/rules.md': 'ignored but still a surface\n',
        'node_modules/pkg/CLAUDE.md': 'ignored, not listed by git\n',
      });
      const judge = await ex.createJudgeFolder(folder);
      const cwd = judge.path;
      expect(judge).toMatchObject({ snapshotId: snapshot.id });
      expect(judge.path).not.toBe(folder.path);
      if (process.platform === 'darwin') expect(judge.copyMethod).toBe('clonefile');

      for (const gone of [
        'CLAUDE.md',
        'CLAUDE.local.md',
        'AGENTS.md',
        '.mcp.json',
        '.claude',
        'packages/x/CLAUDE.md',
        'packages/x/AGENTS.md',
        'packages/x/.claude',
        'node_modules/pkg/.claude',
      ]) {
        expect(await exists(join(cwd, gone)), gone).toBe(false);
      }
      expect(await readFile(join(cwd, 'src/a.ts'), 'utf8')).toBe('three\nfixed by the agent\n');
      expect(await readFile(join(cwd, 'src/new.ts'), 'utf8')).toBe('new\n');
      expect(await readFile(join(cwd, 'README.md'), 'utf8')).toBe('readme\n');
      expect(await readFile(join(cwd, 'packages/x/keep.md'), 'utf8')).toBe('keep\n');
      expect(await exists(join(cwd, 'src/b.ts'))).toBe(false);
      expect(await exists(join(cwd, 'node_modules/pkg/CLAUDE.md'))).toBe(true);
      expect(git(cwd, ['rev-list', '--all', '--count']).trim()).toBe('1');
      expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(git(folder.path, ['rev-parse', 'HEAD']));

      expect(await readFile(join(folder.path, 'CLAUDE.md'), 'utf8')).toBe('# Rules\nuse spaces\n');
      expect(await ex.listRunFolders()).toEqual([folder]);
      await ex.remove(judge);
      expect(await exists(cwd)).toBe(false);
      expect(await ex.listRunFolders()).toEqual([folder]);
    },
  );

  it('removes a failed judge copy', { timeout: TIMEOUT }, async () => {
    const error = await rejection(
      ex.createJudgeFolder({ path: join(temp, 'missing-run-folder'), snapshotId: 'x' }),
    );
    expect(error.reason).toBe('copy_failed');
    expect(await readdir(join(root, 'folders'))).toEqual([]);
  });

  it('lists nothing before any run folder exists', async () => {
    expect(await executor().listRunFolders()).toEqual([]);
  });

  it('falls back to a full copy when the native copy fails', { timeout: TIMEOUT }, async () => {
    const other = executor({ platform: 'win32' });
    const folder = await other.createRunFolder(snapshot);
    expect(folder.copyMethod).toBe('node_copy');
    expect(git(folder.path, ['rev-list', '--all', '--count']).trim()).toBe('1');

    const failing: ProcessRunner = (file, args, options) =>
      file === 'cp' ? Promise.reject(new Error('no cp')) : spawnProcess(file, args, options);
    const fallback = executor({ platform: 'linux', run: failing });
    expect((await fallback.createRunFolder(snapshot)).copyMethod).toBe('node_copy');

    const linux = executor({ platform: 'linux' });
    const copied = await linux.createRunFolder(snapshot);
    expect(['reflink_auto', 'node_copy']).toContain(copied.copyMethod);

    const error = await rejection(
      other.createRunFolder({ ...snapshot, path: join(temp, 'missing-snapshot') }),
    );
    expect(error.reason).toBe('copy_failed');
  });
});
