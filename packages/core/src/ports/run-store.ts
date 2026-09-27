import type { Experiment } from '../domain/experiment.js';
import type { Review } from '../domain/review.js';
import type { RunKey } from '../domain/run-key.js';
import type { Run } from '../domain/run.js';
import type { ExperimentId, RunId } from '../kernel/ids.js';

export interface RunFilter {
  readonly experimentId?: ExperimentId;
  /** Exact match on every field of the run key. */
  readonly key?: RunKey;
}

/**
 * The local store of runs (implementations: JSON files plus a `node:sqlite` index, in-memory for
 * tests).
 *
 * Contract:
 * - `save` is idempotent per run id: saving again replaces the run.
 * - Reads return data that passed the domain schemas; a corrupt file is an error, not a skip.
 * - `list` returns runs in `startedAt` order.
 * - Reviews are stored separately from runs and never modify a run's grades.
 * - `saveReview` rejects a review whose run is not in the store.
 * - `listReviews` returns reviews in `createdAt` order.
 */
export interface RunStore {
  save(run: Run): Promise<void>;
  get(id: RunId): Promise<Run | undefined>;
  list(filter?: RunFilter): Promise<Run[]>;
  saveExperiment(experiment: Experiment): Promise<void>;
  getExperiment(id: ExperimentId): Promise<Experiment | undefined>;
  /** Newest first. */
  listExperiments(): Promise<Experiment[]>;
  saveReview(review: Review): Promise<void>;
  listReviews(filter?: { readonly runId?: RunId }): Promise<Review[]>;
}
