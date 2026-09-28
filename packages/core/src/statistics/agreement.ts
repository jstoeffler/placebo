import type { Agreement, AgreementCount, ChecklistAnswer, Review } from '../domain/review.js';
import type { Run } from '../domain/run.js';

type ChecklistReview = Review & { readonly answer: { readonly type: 'checklist' } };
type ComparisonReview = Review & { readonly answer: { readonly type: 'comparison' } };

/** A running tally, turned into an `AgreementCount` at the end. */
class Tally {
  compared = 0;
  agreed = 0;

  add(same: boolean): void {
    this.compared += 1;
    if (same) this.agreed += 1;
  }

  count(): AgreementCount {
    return { compared: this.compared, agreed: this.agreed };
  }
}

/**
 * Agreement between reviewers and the judge, and between reviewers, over the reviews of `runs`
 * (brief §9); undefined when none of `runs` has a review.
 *
 * - Checklist, per task and question: each reviewer's yes or no on a run against the judge's
 *   answer to the same question on that run, and every pair of reviewers who answered it on
 *   the same run.
 * - Comparison, per task: each reviewer's preferred run of a pair against the judge's, when the
 *   judge compared the same two runs, and every pair of reviewers who compared the same two runs.
 *
 * Only a reviewer's latest review of a run (or pair) counts. Tasks follow the order of `runs`;
 * questions follow the order they were first answered in.
 */
export function agreementOf(
  runs: readonly Run[],
  reviews: readonly Review[],
): Agreement | undefined {
  const runsById = new Map(runs.map((run) => [run.id as string, run]));
  const latest = latestPerReviewer(reviews.filter((review) => runsById.has(review.runId)));
  if (latest.length === 0) return undefined;

  const taskOrder = [...new Set(runs.map((run) => run.taskId as string))];
  const questions = new Map<string, { judge: Tally; reviewers: Tally }>();
  const comparisons = new Map<string, { judge: Tally; reviewers: Tally }>();
  const questionKeys: [string, string][] = [];
  const questionTally = (taskId: string, question: string) => {
    const key = JSON.stringify([taskId, question]);
    let tally = questions.get(key);
    if (tally === undefined) {
      tally = { judge: new Tally(), reviewers: new Tally() };
      questions.set(key, tally);
      questionKeys.push([taskId, question]);
    }
    return tally;
  };
  const comparisonTally = (taskId: string) => {
    let tally = comparisons.get(taskId);
    if (tally === undefined) {
      tally = { judge: new Tally(), reviewers: new Tally() };
      comparisons.set(taskId, tally);
    }
    return tally;
  };

  for (const group of groupBy(latest, subjectOf)) {
    const first = group[0];
    const run = first === undefined ? undefined : runsById.get(first.runId);
    if (run === undefined || first === undefined) continue;
    if (first.answer.type === 'checklist') {
      const checklists = group as ChecklistReview[];
      const judge = judgeAnswers(run);
      for (const review of checklists) {
        for (const answer of review.answer.answers) {
          const judged = judge.get(answer.question);
          const tally = questionTally(run.taskId, answer.question);
          if (judged !== undefined) tally.judge.add(judged === answer.yes);
        }
      }
      for (const [left, right] of pairs(checklists)) {
        const rightAnswers = answersByQuestion(right.answer.answers);
        for (const answer of left.answer.answers) {
          const other = rightAnswers.get(answer.question);
          if (other !== undefined) {
            questionTally(run.taskId, answer.question).reviewers.add(other === answer.yes);
          }
        }
      }
    } else {
      const compared = group as ComparisonReview[];
      const tally = comparisonTally(run.taskId);
      const judged = judgePreference(run, first.answer.opponentRunId);
      for (const review of compared) {
        if (judged !== undefined) tally.judge.add(judged === review.answer.won);
      }
      for (const [left, right] of pairs(compared)) {
        tally.reviewers.add(left.answer.won === right.answer.won);
      }
    }
  }

  const byTask = (taskId: string) => taskOrder.indexOf(taskId);
  return {
    reviewers: [...new Set(latest.map((review) => review.reviewer))],
    questions: questionKeys
      .map(([taskId, question]) => ({ taskId, question }))
      .sort((a, b) => byTask(a.taskId) - byTask(b.taskId))
      .map(({ taskId, question }) => {
        const tally = questionTally(taskId, question);
        return {
          taskId: taskId as Run['taskId'],
          question,
          withJudge: tally.judge.count(),
          betweenReviewers: tally.reviewers.count(),
        };
      }),
    comparisons: [...comparisons.entries()]
      .sort(([a], [b]) => byTask(a) - byTask(b))
      .map(([taskId, tally]) => ({
        taskId: taskId as Run['taskId'],
        withJudge: tally.judge.count(),
        betweenReviewers: tally.reviewers.count(),
      })),
  };
}

/** What a review is about: a run's checklist, or a pair of runs. */
function subjectOf(review: Review): string {
  return review.answer.type === 'checklist'
    ? JSON.stringify(['checklist', review.runId])
    : JSON.stringify(['comparison', review.runId, review.answer.opponentRunId]);
}

/** Each reviewer's latest review of each subject, in the order of first review. */
function latestPerReviewer(reviews: readonly Review[]): Review[] {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const key = JSON.stringify([review.reviewer, subjectOf(review)]);
    const known = latest.get(key);
    if (known === undefined || known.createdAt <= review.createdAt) latest.set(key, review);
  }
  return [...latest.values()];
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return [...groups.values()];
}

/** Every unordered pair of distinct entries. */
function pairs<T>(items: readonly T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push([items[i] as T, items[j] as T]);
  }
  return out;
}

function answersByQuestion(answers: readonly ChecklistAnswer[]): Map<string, boolean> {
  return new Map(answers.map((answer) => [answer.question, answer.yes]));
}

/** The judge's final answer per checklist question on `run`, the first grade's when several. */
function judgeAnswers(run: Run): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const grade of run.grades) {
    if (grade.detail.type !== 'judge' || grade.detail.answers === undefined) continue;
    for (const answer of grade.detail.answers) {
      if (!found.has(answer.question)) found.set(answer.question, answer.yes);
    }
  }
  return found;
}

/** Whether the judge preferred `run` over `opponentRunId`; undefined if it never compared them. */
function judgePreference(run: Run, opponentRunId: string): boolean | undefined {
  for (const grade of run.grades) {
    if (grade.detail.type === 'comparison' && grade.detail.opponentRunId === opponentRunId) {
      return grade.detail.preferred;
    }
  }
  return undefined;
}
