import { randomBytes } from 'node:crypto';
import {
  type Experiment,
  type Grade,
  parseQuestions,
  type Random,
  type Review,
  type ReviewCheck,
  type ReviewComparison,
  type ReviewItem,
  type ReviewSession,
  type Run,
  type RunId,
  type Suite,
  type Task,
} from '@placebo-eval/core';
import { ReviewSession as ReviewSessionSchema } from '@placebo-eval/core/results';

/** One run to review, with the run id the token stands for. Never sent as is. */
interface PassItem {
  readonly runId: RunId;
  readonly item: Omit<ReviewItem, 'answered'>;
}

/**
 * One pair to compare, with what its token stands for: the treatment run, the control run it
 * faces and the side the treatment run is shown on. Never sent as is.
 */
interface PassComparison {
  readonly treatmentRunId: RunId;
  readonly controlRunId: RunId;
  readonly treatmentSide: 'a' | 'b';
  readonly comparison: Omit<ReviewComparison, 'answered'>;
}

/** What a token stands for. */
export type Resolved =
  | { readonly type: 'item'; readonly runId: RunId; readonly questions: readonly string[] }
  | {
      readonly type: 'comparison';
      readonly treatmentRunId: RunId;
      readonly controlRunId: RunId;
      readonly treatmentSide: 'a' | 'b';
    };

/**
 * A review pass over one experiment: every run of a task with checklist or review questions,
 * and every treatment run of a task with a comparison grader paired with a control run of the
 * same task. Each gets a random token; only the pass knows what a token stands for.
 */
export interface ReviewPass {
  readonly experimentId: Experiment['id'];
  readonly taskCount: number;
  /** The blinded session for `reviewer`: what they have not reviewed first. */
  sessionFor(reviewer: string | null, reviews: readonly Review[]): ReviewSession;
  resolve(token: string): Resolved | undefined;
  /** Items and comparisons `reviewer` has not reviewed yet. */
  remaining(reviewer: string, reviews: readonly Review[]): number;
  readonly itemCount: number;
  readonly comparisonCount: number;
}

export interface ReviewPassInput {
  readonly experiment: Experiment;
  /** The experiment's runs. */
  readonly runs: readonly Run[];
  readonly suite: Pick<Suite, 'tasks'>;
  /** The suite's files, keyed by path relative to `.placebo/`, for the question files. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** Seeded: the order of the queue, the control run each pair draws and every `a`/`b` side. */
  readonly random: Random;
  /** Makes each token; random bytes by default. */
  readonly newToken?: () => string;
}

export function createReviewPass(input: ReviewPassInput): ReviewPass {
  const newToken = input.newToken ?? (() => randomBytes(9).toString('base64url'));
  const tasks = input.experiment.taskIds
    .map((id) => input.suite.tasks.find((task) => task.id === id))
    .filter((task): task is Task => task !== undefined);
  const decoder = new TextDecoder();
  const items: PassItem[] = [];
  const comparisons: PassComparison[] = [];

  for (const task of tasks) {
    const runs = input.runs.filter((run) => run.taskId === task.id);
    const questions = questionsOf(task, (path) => {
      const bytes = input.files.get(path);
      return bytes === undefined ? '' : decoder.decode(bytes);
    });
    if (questions.length > 0) {
      for (const run of runs) {
        items.push({
          runId: run.id,
          item: {
            token: newToken(),
            taskId: task.id,
            prompt: task.prompt,
            change: run.change,
            checks: checksOf(task, run.grades),
            events: run.events,
            questions,
          },
        });
      }
    }
    if (task.graders.some((spec) => spec.type === 'comparison')) {
      const controls = runs.filter((run) => run.arm.kind === 'control');
      if (controls.length === 0) continue;
      for (const run of runs.filter((candidate) => candidate.arm.kind === 'treatment')) {
        const control = opponentOf(run, controls, input.random);
        const treatmentSide = input.random.next() < 0.5 ? 'a' : 'b';
        const side = (of: Run) => ({ change: of.change, checks: checksOf(task, of.grades) });
        const [a, b] = treatmentSide === 'a' ? [run, control] : [control, run];
        comparisons.push({
          treatmentRunId: run.id,
          controlRunId: control.id,
          treatmentSide,
          comparison: {
            token: newToken(),
            taskId: task.id,
            prompt: task.prompt,
            a: side(a),
            b: side(b),
          },
        });
      }
    }
  }

  // Shuffled, so the queue's order says nothing about arms.
  const queue = input.random.shuffle(items);
  const pairs = input.random.shuffle(comparisons);
  const itemsByToken = new Map(queue.map((entry) => [entry.item.token, entry]));
  const pairsByToken = new Map(pairs.map((entry) => [entry.comparison.token, entry]));

  const reviewedItem = (entry: PassItem, reviewer: string | null, reviews: readonly Review[]) =>
    reviewer !== null &&
    reviews.some(
      (review) =>
        review.reviewer === reviewer &&
        review.runId === entry.runId &&
        review.answer.type === 'checklist',
    );
  const reviewedPair = (
    entry: PassComparison,
    reviewer: string | null,
    reviews: readonly Review[],
  ) =>
    reviewer !== null &&
    reviews.some(
      (review) =>
        review.reviewer === reviewer &&
        review.runId === entry.treatmentRunId &&
        review.answer.type === 'comparison' &&
        review.answer.opponentRunId === entry.controlRunId,
    );
  const unansweredFirst = <T extends { readonly answered: boolean }>(list: T[]): T[] => [
    ...list.filter((entry) => !entry.answered),
    ...list.filter((entry) => entry.answered),
  ];

  return {
    experimentId: input.experiment.id,
    taskCount: tasks.length,
    itemCount: queue.length,
    comparisonCount: pairs.length,
    sessionFor(reviewer, reviews) {
      // Parsed on the way out: the strict schema rejects any field a bug might add.
      return ReviewSessionSchema.parse({
        experimentId: input.experiment.id,
        reviewer,
        taskCount: tasks.length,
        items: unansweredFirst(
          queue.map((entry) => ({
            ...entry.item,
            answered: reviewedItem(entry, reviewer, reviews),
          })),
        ),
        comparisons: unansweredFirst(
          pairs.map((entry) => ({
            ...entry.comparison,
            answered: reviewedPair(entry, reviewer, reviews),
          })),
        ),
      });
    },
    resolve(token) {
      const item = itemsByToken.get(token);
      if (item !== undefined) {
        return { type: 'item', runId: item.runId, questions: item.item.questions };
      }
      const pair = pairsByToken.get(token);
      if (pair === undefined) return undefined;
      return {
        type: 'comparison',
        treatmentRunId: pair.treatmentRunId,
        controlRunId: pair.controlRunId,
        treatmentSide: pair.treatmentSide,
      };
    },
    remaining(reviewer, reviews) {
      return (
        queue.filter((entry) => !reviewedItem(entry, reviewer, reviews)).length +
        pairs.filter((entry) => !reviewedPair(entry, reviewer, reviews)).length
      );
    },
  };
}

/**
 * The questions a reviewer answers on a run of `task`: those of its checklist graders, which the
 * judge answers too, then its review questions, each once.
 */
function questionsOf(task: Task, read: (path: string) => string): string[] {
  const paths = [
    ...task.graders.flatMap((spec) => (spec.type === 'checklist' ? [spec.questions] : [])),
    ...(task.review === undefined ? [] : [task.review.questions]),
  ];
  return [...new Set(paths.flatMap((path) => parseQuestions(read(path))))];
}

/** The results of the task's command graders on a run, in declaration order. */
function checksOf(task: Task, grades: readonly Grade[]): ReviewCheck[] {
  return grades.flatMap((grade): ReviewCheck[] => {
    if (grade.grader.type !== 'command' || grade.kind !== 'deterministic') return [];
    const spec = task.graders[grade.grader.index];
    const { detail } = grade;
    const command = spec?.type === 'command' ? spec.run : 'command';
    if (detail.type === 'command') {
      return [{ command, exitCode: detail.exitCode, stdout: detail.stdout, stderr: detail.stderr }];
    }
    const message = detail.type === 'error' ? detail.message : 'no result';
    return [{ command, exitCode: null, stdout: '', stderr: message }];
  });
}

/**
 * The control run a treatment run faces: the one its comparison judge faced, so reviewers and
 * the judge compare the same pairs, otherwise one drawn at random, as the judge draws.
 */
function opponentOf(run: Run, controls: readonly Run[], random: Random): Run {
  for (const grade of run.grades) {
    if (grade.detail.type !== 'comparison') continue;
    const opponentRunId = grade.detail.opponentRunId;
    const judged = controls.find((control) => control.id === opponentRunId);
    if (judged !== undefined) return judged;
  }
  const drawn = controls[random.int(0, controls.length)];
  if (drawn === undefined) throw new Error('opponentOf needs at least one control run');
  return drawn;
}
