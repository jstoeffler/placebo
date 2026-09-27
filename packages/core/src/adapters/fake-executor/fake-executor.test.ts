import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeExecutor } from './fake-executor.js';

const COMMIT = 'b'.repeat(40);

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

describe('FakeExecutor', () => {
  it('returns deterministic snapshots and numbered virtual run folders', async () => {
    const executor = new FakeExecutor();
    const snapshot = await executor.prepareSnapshot({ repo: '.', commit: COMMIT, setup: 'pnpm i' });
    expect(snapshot.commit).toBe(COMMIT);
    expect(snapshot.id).toMatch(new RegExp(`^${COMMIT}-[0-9a-f]{12}$`));
    expect(await executor.prepareSnapshot({ repo: '.', commit: COMMIT, setup: 'pnpm i' })).toEqual(
      snapshot,
    );
    const short = await executor.prepareSnapshot({ repo: '.', commit: 'abc1234' });
    expect(short.commit).toMatch(/^[0-9a-f]{40}$/);

    const control = await executor.createRunFolder(snapshot);
    const treatment = await executor.createRunFolder(
      snapshot,
      'diff --git a/CLAUDE.md b/CLAUDE.md',
    );
    expect(control).toEqual({ path: '/placebo-fake/folders/run-1', snapshotId: snapshot.id });
    expect(treatment.path).toBe('/placebo-fake/folders/run-2');
    expect(await executor.listRunFolders()).toEqual([control, treatment]);
    await executor.remove(control);
    expect(await executor.listRunFolders()).toEqual([treatment]);
    await executor.remove(control);

    expect(executor.calls.map((call) => call.method)).toEqual([
      'prepareSnapshot',
      'prepareSnapshot',
      'prepareSnapshot',
      'createRunFolder',
      'createRunFolder',
      'remove',
      'remove',
    ]);
    expect(executor.calls[4]).toEqual({
      method: 'createRunFolder',
      snapshotId: snapshot.id,
      patch: 'diff --git a/CLAUDE.md b/CLAUDE.md',
    });
  });

  it('returns scripted changes and exec results, with defaults', async () => {
    const change = { diff: '+x\n', files: ['a.ts'], bytes: 3 };
    const byMap = new FakeExecutor({
      change,
      exec: { 'pnpm test': { exitCode: 1, stderr: 'failed' } },
    });
    const snapshot = await byMap.prepareSnapshot({ repo: '.', commit: COMMIT });
    const folder = await byMap.createRunFolder(snapshot);
    expect(await byMap.computeChange(folder)).toEqual(change);
    expect(await byMap.exec(folder, 'pnpm test')).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'failed',
      durationMs: 0,
    });
    expect((await byMap.exec(folder, 'other')).exitCode).toBe(0);

    const byFunction = new FakeExecutor({
      change: (runFolder) => ({ diff: runFolder.path, files: [], bytes: runFolder.path.length }),
      exec: (_runFolder, command) => ({ stdout: command.toUpperCase() }),
    });
    expect((await byFunction.computeChange(folder)).diff).toBe(folder.path);
    expect((await byFunction.exec(folder, 'echo')).stdout).toBe('ECHO');
    expect(await new FakeExecutor().computeChange(folder)).toEqual({
      diff: '',
      files: [],
      bytes: 0,
    });

    const files = [{ path: 'tests/hidden.test.ts', content: 'x' }];
    await byMap.injectHidden(folder, files);
    expect(byMap.calls.at(-1)).toEqual({ method: 'injectHidden', path: folder.path, files });
  });

  it('creates and removes real directories when asked', async () => {
    const executor = new FakeExecutor({ realDirs: true });
    const snapshot = await executor.prepareSnapshot({ repo: '.', commit: COMMIT });
    const one = await executor.createRunFolder(snapshot);
    const two = await executor.createRunFolder(snapshot);
    await writeFile(join(one.path, 'written.txt'), 'by a fake runner');
    expect(await isDirectory(one.path)).toBe(true);
    await executor.remove(one);
    expect(await isDirectory(one.path)).toBe(false);
    await executor.cleanup();
    expect(await isDirectory(two.path)).toBe(false);
    expect(await executor.listRunFolders()).toEqual([]);
  });
});
