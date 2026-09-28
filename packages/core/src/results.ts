// The results.json contract (ADR 0013). The report imports only this entry point.
export * from './domain/results.js';
export type * from './domain/arm.js';
export type * from './domain/change.js';
export type * from './domain/events.js';
export type * from './domain/experiment.js';
export type * from './domain/grade.js';
export type * from './domain/measurements.js';
// Runtime too: review mode validates the review session it is served.
export * from './domain/review.js';
export type * from './domain/run.js';
export type * from './domain/run-key.js';
export type * from './domain/warnings.js';
export {
  METRICS,
  type Metric,
  type MetricInfo,
  type MetricRow,
  type MetricUnit,
  type Verdict,
} from './domain/metrics.js';
