// The `RunStore` contract as a Vitest suite. Every implementation runs it from its own test file:
// `runStoreContractTests('MemoryRunStore', async () => ({ store: new MemoryRunStore(), ... }))`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunKey } from '../domain/run-key.js';
import type { Run } from '../domain/run.js';
import { ExperimentId, RunId } from '../kernel/ids.js';
import type { RunStore } from '../ports/run-store.js';
import { makeExperiment, makeReview, makeRun, sampleRunKey } from './fixtures.js';

/** A store under test and how to tear it down. The optional hooks enable disk-only clauses. */
export interface RunStoreHarness {
  readonly store: RunStore;
  /** Closes the store and every sibling, and removes whatever the store created. */
  dispose(): Promise<void>;
  /** Opens another store over the same location; `dispose` closes it. Disk stores only. */
  openSibling?(): Promise<RunStore>;
  /** Replaces the stored form of a saved run with content that fails to parse. Disk stores only. */
  corruptRun?(run: Run): Promise<void>;
}

const OTHER_SHA = 'd'.repeat(64);

/** A run key equal to the sample's except for one field. */
const KEY_VARIATIONS: readonly (readonly [keyof RunKey, string])[] = [
  ['taskHash', OTHER_SHA],
  ['variantHash', OTHER_SHA],
  ['commitHash', 'e'.repeat(40)],
  ['subjectModel', 'claude-opus-5-5'],
  ['claudeCodeVersion', '2.1.284'],
];

const ids = (items: readonly { readonly id: string }[]): string[] => items.map((item) => item.id);

export function runStoreContractTests(
  name: string,
  makeStore: () => Promise<RunStoreHarness>,
): void {
  describe(`${name} (RunStore contract)`, () => {
    let harness: RunStoreHarness;
    let store: RunStore;

    beforeEach(async () => {
      harness = await makeStore();
      store = harness.store;
    });

    afterEach(async () => {
      await harness.dispose();
    });

    describe('save and get', () => {
      it('round-trips a run exactly, nested events and grades included', async () => {
        const run = makeRun();
        await store.save(run);
        expect(await store.get(run.id)).toStrictEqual(run);
      });

      it('keeps optional fields absent', async () => {
        const run = makeRun({ runFolder: undefined, arm: { kind: 'control' }, grades: [] });
        await store.save(run);
        const got = await store.get(run.id);
        expect(got).toStrictEqual(run);
        expect(got).not.toHaveProperty('runFolder');
      });

      it('keeps arbitrary nested tool inputs', async () => {
        const run = makeRun({
          events: [
            ...makeRun().events,
            {
              type: 'tool_call',
              timestamp: '2026-09-27T10:01:00.000Z',
              id: 'tc2',
              name: 'Edit',
              input: {
                edits: [{ old: 'a', new: 'b' }],
                flags: { dry: false, level: 2 },
                none: null,
              },
            },
          ],
        });
        await store.save(run);
        expect(await store.get(run.id)).toStrictEqual(run);
      });

      it('replaces the run when saved again with the same id', async () => {
        await store.save(makeRun());
        const replacement = makeRun({ outcome: 'failed', grades: [], infraRetries: 2 });
        await store.save(replacement);
        expect(await store.get(replacement.id)).toStrictEqual(replacement);
        expect(await store.list()).toStrictEqual([replacement]);
      });

      it('replaces the run when saved again under another experiment', async () => {
        await store.save(makeRun());
        const moved = makeRun({ experimentId: 'exp-2' });
        await store.save(moved);
        expect(await store.list()).toStrictEqual([moved]);
        expect(await store.list({ experimentId: ExperimentId.parse('exp-1') })).toStrictEqual([]);
      });

      it('returns undefined for an unknown id', async () => {
        await store.save(makeRun());
        expect(await store.get(RunId.parse('missing'))).toBeUndefined();
      });

      it('does not let callers mutate stored runs', async () => {
        const run = makeRun();
        await store.save(run);
        run.grades.length = 0;
        const got = await store.get(run.id);
        got!.events.length = 0;
        expect(await store.get(run.id)).toStrictEqual(makeRun());
      });
    });

    describe('list', () => {
      it('is empty for an empty store', async () => {
        expect(await store.list()).toStrictEqual([]);
      });

      it('returns every run in startedAt order, whatever the insertion order', async () => {
        await store.save(makeRun({ id: 'late', startedAt: '2026-09-27T12:00:00.000Z' }));
        // Text order would put 'middle' first: '.' sorts before 'Z'.
        await store.save(makeRun({ id: 'middle', startedAt: '2026-09-27T09:00:00.500Z' }));
        await store.save(makeRun({ id: 'early', startedAt: '2026-09-27T09:00:00Z' }));
        await store.save(makeRun({ id: 'noon', startedAt: '2026-09-27T12:00:00Z' }));
        expect(ids(await store.list())).toStrictEqual(['early', 'middle', 'late', 'noon']);
      });

      it('filters by experiment, keeping startedAt order', async () => {
        await store.save(makeRun({ id: 'a2', startedAt: '2026-09-27T11:00:00.000Z' }));
        await store.save(makeRun({ id: 'b1', experimentId: 'exp-2' }));
        await store.save(makeRun({ id: 'a1', startedAt: '2026-09-27T09:00:00.000Z' }));
        const exp1 = await store.list({ experimentId: ExperimentId.parse('exp-1') });
        expect(ids(exp1)).toStrictEqual(['a1', 'a2']);
        const exp2 = await store.list({ experimentId: ExperimentId.parse('exp-2') });
        expect(ids(exp2)).toStrictEqual(['b1']);
        expect(await store.list({ experimentId: ExperimentId.parse('exp-3') })).toStrictEqual([]);
      });

      it('filters by run key, matching every field exactly', async () => {
        const match = makeRun({ id: 'match', experimentId: 'exp-2' });
        await store.save(match);
        for (const [field, value] of KEY_VARIATIONS)
          await store.save(
            makeRun({ id: `other-${field}`, key: { ...sampleRunKey, [field]: value } }),
          );
        expect(await store.list({ key: match.key })).toStrictEqual([match]);
      });

      it.each(KEY_VARIATIONS)('misses when only %s differs', async (field, value) => {
        await store.save(makeRun());
        const key = makeRun({ key: { ...sampleRunKey, [field]: value } }).key;
        expect(await store.list({ key })).toStrictEqual([]);
      });

      it('combines experiment and key filters', async () => {
        const run = makeRun();
        await store.save(run);
        await store.save(makeRun({ id: 'run-2', experimentId: 'exp-2' }));
        expect(
          await store.list({ experimentId: ExperimentId.parse('exp-1'), key: run.key }),
        ).toStrictEqual([run]);
      });
    });

    describe('experiments', () => {
      it('round-trips an experiment and returns undefined for an unknown id', async () => {
        const experiment = makeExperiment();
        await store.saveExperiment(experiment);
        expect(await store.getExperiment(experiment.id)).toStrictEqual(experiment);
        expect(await store.getExperiment(ExperimentId.parse('missing'))).toBeUndefined();
      });

      it('replaces an experiment saved again with the same id', async () => {
        await store.saveExperiment(makeExperiment());
        const replacement = makeExperiment({ runsPerTask: 9 });
        await store.saveExperiment(replacement);
        expect(await store.listExperiments()).toStrictEqual([replacement]);
      });

      it('lists experiments newest first', async () => {
        await store.saveExperiment(
          makeExperiment({ id: 'mid', createdAt: '2026-09-02T00:00:00Z' }),
        );
        await store.saveExperiment(
          makeExperiment({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' }),
        );
        await store.saveExperiment(
          makeExperiment({ id: 'new', createdAt: '2026-09-03T00:00:00.000Z' }),
        );
        expect(ids(await store.listExperiments())).toStrictEqual(['new', 'mid', 'old']);
      });
    });

    describe('reviews', () => {
      beforeEach(async () => {
        await store.save(makeRun());
        await store.save(makeRun({ id: 'run-2', experimentId: 'exp-2' }));
      });

      it('saves reviews and lists them all or by run', async () => {
        const first = makeReview();
        const second = makeReview({ id: 'rev-2', runId: 'run-2', reviewer: 'ana' });
        const third = makeReview({
          id: 'rev-3',
          answer: { type: 'comparison', opponentRunId: 'run-2', won: true, note: 'cleaner' },
        });
        for (const review of [first, second, third]) await store.saveReview(review);
        const sorted = (reviews: (typeof first)[]) =>
          [...reviews].sort((a, b) => (a.id < b.id ? -1 : 1));
        expect(sorted(await store.listReviews())).toStrictEqual([first, second, third]);
        expect(sorted(await store.listReviews({ runId: RunId.parse('run-1') }))).toStrictEqual([
          first,
          third,
        ]);
        expect(await store.listReviews({ runId: RunId.parse('run-2') })).toStrictEqual([second]);
        expect(await store.listReviews({ runId: RunId.parse('missing') })).toStrictEqual([]);
      });

      it('replaces a review saved again with the same id', async () => {
        await store.saveReview(makeReview());
        const replacement = makeReview({ reviewer: 'ana' });
        await store.saveReview(replacement);
        expect(await store.listReviews()).toStrictEqual([replacement]);
      });

      it("never changes the run's grades", async () => {
        const before = await store.get(RunId.parse('run-1'));
        await store.saveReview(makeReview());
        expect(await store.get(RunId.parse('run-1'))).toStrictEqual(before);
      });

      it('rejects a review of an unknown run', async () => {
        await expect(store.saveReview(makeReview({ runId: 'missing' }))).rejects.toThrow(/missing/);
        expect(await store.listReviews()).toStrictEqual([]);
      });
    });

    describe('shared location', () => {
      it("sees another store's writes over the same location", async (context) => {
        if (!harness.openSibling) {
          context.skip();
          return;
        }
        const other = await harness.openSibling();
        const run = makeRun();
        const experiment = makeExperiment();
        await store.save(run);
        await other.saveExperiment(experiment);
        await other.saveReview(makeReview());
        expect(await other.get(run.id)).toStrictEqual(run);
        expect(await other.list({ key: run.key })).toStrictEqual([run]);
        expect(await store.getExperiment(experiment.id)).toStrictEqual(experiment);
        expect(await store.listExperiments()).toStrictEqual([experiment]);
        expect(await store.listReviews()).toStrictEqual([makeReview()]);
      });
    });

    describe('corruption', () => {
      it('throws on reading a corrupt run instead of skipping it', async (context) => {
        if (!harness.corruptRun) {
          context.skip();
          return;
        }
        const run = makeRun();
        await store.save(run);
        await store.save(makeRun({ id: 'run-2' }));
        await harness.corruptRun(run);
        await expect(store.get(run.id)).rejects.toThrow();
        await expect(store.list()).rejects.toThrow();
        await expect(store.list({ key: run.key })).rejects.toThrow();
      });
    });
  });
}
