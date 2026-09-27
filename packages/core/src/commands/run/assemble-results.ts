import type { Experiment } from '../../domain/experiment.js';
import { RESULTS_SCHEMA_VERSION, Results, type TaskSummary } from '../../domain/results.js';
import type { Review } from '../../domain/review.js';
import type { Run } from '../../domain/run.js';
import type { GraderSpec, Margins, Suite } from '../../domain/suite.js';
import type { Warning } from '../../domain/warnings.js';
import { summarizeExperiment } from '../../statistics/verdict-card.js';
import type { Clock } from '../../kernel/clock.js';
import type { Random } from '../../kernel/random.js';
import { mergeWarnings } from './warnings.js';

export interface AssembleResultsInput {
  readonly experiment: Experiment;
  /** The experiment's runs; runs of other experiments are left out. */
  readonly runs: readonly Run[];
  /** Reviews of any run; only those of the experiment's runs are kept. */
  readonly reviews: readonly Review[];
  /** Where task prompts and graders come from; tasks of the experiment only are summarized. */
  readonly suite: Pick<Suite, 'tasks'>;
  readonly margins: Margins;
  /** Seeded, normally `createSeededRandom(experiment.seed)`, so results replay from the seed. */
  readonly random: Random;
  /** Stamps `generatedAt`. */
  readonly clock: Clock;
  /** Warnings found before the runs (see `upfrontWarnings`); merged with the computed ones. */
  readonly warnings?: readonly Warning[];
  /** Resamples per range; statistics' default when absent. */
  readonly resamples?: number;
}

/**
 * The `results.json` contract (ADR 0013) for one experiment: the statistics from
 * `summarizeExperiment` plus the experiment, its arms, margins, task summaries with grader
 * labels, runs, reviews and warnings. Validated with `Results.parse` before it is returned, so a
 * bug here fails loudly instead of writing a report the report package cannot read.
 */
export function assembleResults(input: AssembleResultsInput): Results {
  const { experiment } = input;
  const runs = input.runs.filter((run) => run.experimentId === experiment.id);
  const runIds = new Set<string>(runs.map((run) => run.id));
  const summary = summarizeExperiment({
    runs,
    experiment,
    margins: input.margins,
    random: input.random,
    ...(input.resamples === undefined ? {} : { resamples: input.resamples }),
  });
  const tasks: TaskSummary[] = [];
  for (const taskId of experiment.taskIds) {
    const task = input.suite.tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined) continue;
    tasks.push({
      id: task.id,
      prompt: task.prompt,
      graders: task.graders.map((spec, index) => ({
        index,
        type: spec.type,
        label: graderLabel(spec),
      })),
    });
  }
  return Results.parse({
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: input.clock.now().toISOString(),
    experiment,
    arms: experiment.arms,
    margins: input.margins,
    tasks,
    runs,
    verdictCards: summary.verdictCards,
    breakdown: summary.breakdown,
    deadTasks: summary.deadTasks,
    warnings: mergeWarnings(input.warnings ?? [], summary.warnings),
    reviews: input.reviews.filter((review) => runIds.has(review.runId)),
  });
}

/** A one-line, human-readable description of a grader, e.g. `command: pnpm test`. */
export function graderLabel(spec: GraderSpec): string {
  switch (spec.type) {
    case 'command':
      return `command: ${spec.run}`;
    case 'file_exists':
      return `file_exists: ${spec.path}`;
    case 'file_modified':
      return `file_modified: ${spec.path}`;
    case 'regex':
      return `regex: /${spec.pattern}/ on the ${spec.on}`;
    case 'tool_used':
      return `tool_used: ${spec.tool}`;
    case 'checklist':
      return `checklist: ${spec.questions}${spec.agentic ? ' (agentic)' : ''}`;
    case 'comparison':
      return 'comparison';
  }
}
