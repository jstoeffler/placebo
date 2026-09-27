import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExperimentId, RunId, type Run } from '@placebo-eval/core';
import {
  makeExperiment,
  makeReview,
  makeRun,
  runStoreContractTests,
  sampleRunKey,
} from '@placebo-eval/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStoreFileError, runStoreRoot, SqliteRunStore } from './sqlite-run-store.js';

const runFile = (root: string, run: Run): string =>
  join(root, 'experiments', run.experimentId, 'runs', `${run.id}.json`);

runStoreContractTests('SqliteRunStore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'placebo-run-store-'));
  const stores = [await new SqliteRunStore(root).open()];
  return {
    store: stores[0]!,
    openSibling: async () => {
      const sibling = await new SqliteRunStore(root).open();
      stores.push(sibling);
      return sibling;
    },
    corruptRun: (run) => writeFile(runFile(root, run), '{ not json'),
    dispose: async () => {
      for (const store of stores) store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
});

describe('SqliteRunStore', () => {
  const opened: SqliteRunStore[] = [];
  let root: string;

  async function open(at = root): Promise<SqliteRunStore> {
    const store = await new SqliteRunStore(at).open();
    opened.push(store);
    return store;
  }

  async function populate(store: SqliteRunStore): Promise<void> {
    await store.saveExperiment(makeExperiment());
    await store.saveExperiment(makeExperiment({ id: 'exp-2', createdAt: '2026-09-28T00:00:00Z' }));
    await store.save(makeRun());
    await store.save(
      makeRun({ id: 'run-2', experimentId: 'exp-2', startedAt: '2026-09-27T09:00:00Z' }),
    );
    await store.save(
      makeRun({ id: 'run-3', key: { ...sampleRunKey, subjectModel: 'claude-opus-5-5' } }),
    );
    await store.saveReview(makeReview());
    await store.saveReview(makeReview({ id: 'rev-2', runId: 'run-2' }));
  }

  async function snapshot(store: SqliteRunStore): Promise<unknown> {
    return {
      runs: await store.list(),
      byExperiment: await store.list({ experimentId: ExperimentId.parse('exp-1') }),
      byKey: await store.list({ key: makeRun().key }),
      experiments: await store.listExperiments(),
      reviews: await store.listReviews(),
      reviewsOfRun2: await store.listReviews({ runId: RunId.parse('run-2') }),
    };
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'placebo-run-store-'));
  });

  afterEach(async () => {
    for (const store of opened.splice(0)) store.close();
    await rm(root, { recursive: true, force: true });
  });

  it('places the run store under .placebo/runs of a repo', () => {
    expect(runStoreRoot('/repo')).toBe(join('/repo', '.placebo', 'runs'));
  });

  it('writes the documented layout as pretty JSON with a trailing newline', async () => {
    const store = await open();
    await populate(store);
    const experiment = await readFile(
      join(root, 'experiments', 'exp-1', 'experiment.json'),
      'utf8',
    );
    expect(experiment).toBe(`${JSON.stringify(makeExperiment(), null, 2)}\n`);
    const run = await readFile(join(root, 'experiments', 'exp-2', 'runs', 'run-2.json'), 'utf8');
    expect(JSON.parse(run)).toStrictEqual(await store.get(RunId.parse('run-2')));
    expect(run).toMatch(/^\{\n {2}"id": "run-2",\n/);
    expect(run.endsWith('}\n')).toBe(true);
    // A review lives with its run's experiment.
    const review = await readFile(
      join(root, 'experiments', 'exp-2', 'reviews', 'rev-2.json'),
      'utf8',
    );
    expect(JSON.parse(review)).toStrictEqual(makeReview({ id: 'rev-2', runId: 'run-2' }));
  });

  it('moves the run file when a run is saved again under another experiment', async () => {
    const store = await open();
    const run = makeRun();
    await store.save(run);
    const moved = makeRun({ experimentId: 'exp-2' });
    await store.save(moved);
    await expect(readFile(runFile(root, run))).rejects.toThrow(/ENOENT/);
    expect(JSON.parse(await readFile(runFile(root, moved), 'utf8'))).toStrictEqual(moved);
  });

  it('rebuilds a deleted index on open with the same results', async () => {
    const first = await open();
    await populate(first);
    const before = await snapshot(first);
    first.close();
    for (const file of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm'])
      await rm(join(root, file), { force: true });
    expect(await snapshot(await open())).toStrictEqual(before);
  });

  it('rebuilds an index SQLite cannot read', async () => {
    const first = await open();
    await populate(first);
    const before = await snapshot(first);
    first.close();
    await rm(join(root, 'index.sqlite-wal'), { force: true });
    await rm(join(root, 'index.sqlite-shm'), { force: true });
    await writeFile(join(root, 'index.sqlite'), 'garbage '.repeat(1000));
    expect(await snapshot(await open())).toStrictEqual(before);
  });

  it('rebuilds an index at another schema version', async () => {
    const first = await open();
    await populate(first);
    const before = await snapshot(first);
    first.close();
    const db = new DatabaseSync(join(root, 'index.sqlite'));
    db.exec("UPDATE meta SET value = '0' WHERE key = 'schema_version'; DELETE FROM runs;");
    db.close();
    expect(await snapshot(await open())).toStrictEqual(before);
  });

  it('reindexes JSON files copied in from another root', async () => {
    const other = await mkdtemp(join(tmpdir(), 'placebo-run-store-other-'));
    try {
      await populate(await open(other));
      const store = await open();
      await store.save(makeRun({ id: 'local', experimentId: 'exp-local' }));
      await cp(join(other, 'experiments'), join(root, 'experiments'), { recursive: true });
      expect(await store.get(RunId.parse('run-2'))).toBeUndefined();
      await store.reindex();
      const source = opened.find((store) => store.root === other)!;
      expect(await store.listExperiments()).toStrictEqual(await source.listExperiments());
      expect(await store.listReviews()).toStrictEqual(await source.listReviews());
      expect(await store.get(RunId.parse('run-2'))).toStrictEqual(
        await source.get(RunId.parse('run-2')),
      );
      expect((await store.list()).map((run) => run.id)).toStrictEqual([
        'run-2',
        'local',
        'run-1',
        'run-3',
      ]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('ignores leftover temporary files when reindexing', async () => {
    const store = await open();
    await populate(store);
    await writeFile(join(root, 'experiments', 'exp-1', 'runs', '.abc.tmp'), '{ partial');
    await writeFile(join(root, 'experiments', 'exp-1', 'runs', '.hidden.json'), '{ partial');
    await store.reindex();
    expect(await store.list()).toHaveLength(3);
  });

  it('refuses to reindex a run stored twice', async () => {
    const store = await open();
    await store.save(makeRun());
    await cp(join(root, 'experiments', 'exp-1'), join(root, 'experiments', 'exp-copy'), {
      recursive: true,
    });
    await expect(store.reindex()).rejects.toThrow(/run "run-1" is also stored in/);
  });

  it('throws naming the path when a run file is not JSON', async () => {
    const store = await open();
    const run = makeRun();
    await store.save(run);
    await writeFile(runFile(root, run), '{ not json');
    const error = await store.get(run.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunStoreFileError);
    expect((error as RunStoreFileError).path).toBe(runFile(root, run));
    expect((error as Error).message).toContain(runFile(root, run));
  });

  it('throws naming the path and the issue when a run file fails the schema', async () => {
    const store = await open();
    const run = makeRun();
    await store.save(run);
    await writeFile(runFile(root, run), JSON.stringify({ ...run, infraRetries: -1 }));
    await expect(store.list()).rejects.toThrow(
      `run store file ${runFile(root, run)}: infraRetries: Too small: expected number to be >=0`,
    );
  });

  it('throws naming the path when an indexed file is gone', async () => {
    const store = await open();
    const run = makeRun();
    await store.save(run);
    await rm(runFile(root, run));
    await expect(store.get(run.id)).rejects.toThrow(runFile(root, run));
  });

  it('throws when a file holds another id than the index expects', async () => {
    const store = await open();
    await store.save(makeRun());
    await writeFile(runFile(root, makeRun()), JSON.stringify(makeRun({ id: 'impostor' }), null, 2));
    await expect(store.get(RunId.parse('run-1'))).rejects.toThrow(
      /holds id "impostor" but the index expects "run-1"/,
    );
  });

  it('fails reindex on a corrupt file instead of skipping it', async () => {
    const store = await open();
    await populate(store);
    await writeFile(join(root, 'experiments', 'exp-1', 'experiment.json'), '[]');
    await expect(store.reindex()).rejects.toThrow(RunStoreFileError);
  });

  it('keeps every write from two stores saving concurrently on the same root', async () => {
    const [a, b] = [await open(), await open()];
    const runs = Array.from({ length: 40 }, (_, index) =>
      makeRun({
        id: `run-${String(index).padStart(2, '0')}`,
        startedAt: new Date(Date.UTC(2026, 8, 27, 10, 0, index)).toISOString(),
      }),
    );
    await Promise.all(runs.map((run, index) => (index % 2 === 0 ? a : b).save(run)));
    expect(await a.list()).toStrictEqual(runs);
    expect(await b.list()).toStrictEqual(runs);
    a.close();
    await rm(join(root, 'index.sqlite'));
    expect(await (await open()).list()).toStrictEqual(runs);
  });

  it('rejects ids that are not plain path segments', async () => {
    const store = await open();
    await expect(store.save(makeRun({ id: '../escape' }))).rejects.toThrow(
      /id "..\/escape" cannot be stored/,
    );
    await expect(store.saveExperiment(makeExperiment({ id: 'a/b' }))).rejects.toThrow(
      /id "a\/b" cannot be stored/,
    );
  });

  it('rejects a value that fails its schema before writing it', async () => {
    const store = await open();
    await expect(store.save({ ...makeRun(), infraRetries: -1 })).rejects.toThrow(
      'invalid run: infraRetries: Too small: expected number to be >=0',
    );
    expect(await store.list()).toStrictEqual([]);
  });

  it('must be opened before use and can be reopened after close', async () => {
    const store = new SqliteRunStore(root);
    await expect(store.list()).rejects.toThrow(/is not open; call open\(\) first/);
    await store.open();
    expect(await store.open()).toBe(store);
    await store.save(makeRun());
    store.close();
    await store.open();
    opened.push(store);
    expect(await store.list()).toHaveLength(1);
  });
});
