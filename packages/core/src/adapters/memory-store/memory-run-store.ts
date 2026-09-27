import { Experiment } from '../../domain/experiment.js';
import { Review } from '../../domain/review.js';
import type { RunKey } from '../../domain/run-key.js';
import { Run } from '../../domain/run.js';
import type { ExperimentId, ReviewId, RunId } from '../../kernel/ids.js';
import type { RunFilter, RunStore } from '../../ports/run-store.js';

/**
 * The run store in memory, for command tests. Values pass the domain schemas on save and are
 * cloned on the way in and out, so callers can never mutate stored state.
 */
export class MemoryRunStore implements RunStore {
  readonly #runs = new Map<RunId, Run>();
  readonly #experiments = new Map<ExperimentId, Experiment>();
  readonly #reviews = new Map<ReviewId, Review>();

  save(run: Run): Promise<void> {
    this.#runs.set(run.id, structuredClone(Run.parse(run)));
    return Promise.resolve();
  }

  get(id: RunId): Promise<Run | undefined> {
    const run = this.#runs.get(id);
    return Promise.resolve(run && structuredClone(run));
  }

  list(filter: RunFilter = {}): Promise<Run[]> {
    const { experimentId, key } = filter;
    const runs = [...this.#runs.values()]
      .filter((run) => experimentId === undefined || run.experimentId === experimentId)
      .filter((run) => key === undefined || sameKey(run.key, key))
      .sort((a, b) => byInstant(a.startedAt, b.startedAt) || byId(a.id, b.id));
    return Promise.resolve(structuredClone(runs));
  }

  saveExperiment(experiment: Experiment): Promise<void> {
    this.#experiments.set(experiment.id, structuredClone(Experiment.parse(experiment)));
    return Promise.resolve();
  }

  getExperiment(id: ExperimentId): Promise<Experiment | undefined> {
    const experiment = this.#experiments.get(id);
    return Promise.resolve(experiment && structuredClone(experiment));
  }

  listExperiments(): Promise<Experiment[]> {
    const experiments = [...this.#experiments.values()].sort(
      (a, b) => byInstant(b.createdAt, a.createdAt) || byId(a.id, b.id),
    );
    return Promise.resolve(structuredClone(experiments));
  }

  saveReview(review: Review): Promise<void> {
    if (!this.#runs.has(review.runId))
      return Promise.reject(
        new Error(`cannot save review "${review.id}": unknown run "${review.runId}"`),
      );
    this.#reviews.set(review.id, structuredClone(Review.parse(review)));
    return Promise.resolve();
  }

  listReviews(filter: { readonly runId?: RunId } = {}): Promise<Review[]> {
    const { runId } = filter;
    const reviews = [...this.#reviews.values()]
      .filter((review) => runId === undefined || review.runId === runId)
      .sort((a, b) => byInstant(a.createdAt, b.createdAt) || byId(a.id, b.id));
    return Promise.resolve(structuredClone(reviews));
  }
}

function sameKey(a: RunKey, b: RunKey): boolean {
  return (
    a.taskHash === b.taskHash &&
    a.variantHash === b.variantHash &&
    a.commitHash === b.commitHash &&
    a.subjectModel === b.subjectModel &&
    a.claudeCodeVersion === b.claudeCodeVersion
  );
}

/** Compares ISO datetimes by instant, not text, since their fractional precision varies. */
function byInstant(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
