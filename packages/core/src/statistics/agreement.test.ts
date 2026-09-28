import { describe, expect, it } from 'vitest';
import { sampleGrades, makeReview, makeRun, comparisonGrade } from '../testing/fixtures.js';
import { agreementOf } from './agreement.js';

const Q1 = 'Rounds half up?';
const Q2 = 'Keeps signature?';

/** A checklist judge grade answering `yes1` to Q1 and `yes2` to Q2. */
function judged(yes1: boolean, yes2: boolean): unknown {
  const [, checklist] = sampleGrades;
  return {
    ...checklist,
    score: Number(yes1) + Number(yes2),
    detail: {
      ...checklist?.detail,
      answers: [
        { question: Q1, yes: yes1 },
        { question: Q2, yes: yes2 },
      ],
    },
  };
}

function checklistReview(
  id: string,
  runId: string,
  reviewer: string,
  answers: Record<string, boolean>,
  createdAt = '2026-09-27T11:00:00.000Z',
) {
  return makeReview({
    id,
    runId,
    reviewer,
    createdAt,
    answer: {
      type: 'checklist',
      answers: Object.entries(answers).map(([question, yes]) => ({ question, yes })),
    },
  });
}

function comparisonReview(id: string, runId: string, reviewer: string, won: boolean, opp = 'c1') {
  return makeReview({
    id,
    runId,
    reviewer,
    answer: { type: 'comparison', opponentRunId: opp, won },
  });
}

const t1 = makeRun({ id: 't1', taskId: 'refund', arm: 'rules', grades: [judged(true, false)] });
const t2 = makeRun({ id: 't2', taskId: 'refund', arm: 'rules', grades: [judged(true, true)] });
const g1 = makeRun({ id: 'g1', taskId: 'greeting', arm: 'control', grades: [judged(false, true)] });

describe('agreementOf', () => {
  it('is undefined without reviews of the runs', () => {
    expect(agreementOf([t1], [])).toBeUndefined();
    expect(agreementOf([t1], [checklistReview('r', 'elsewhere', 'ada', { [Q1]: true })])).toBe(
      undefined,
    );
  });

  it('counts reviewer against judge per task and question', () => {
    const agreement = agreementOf(
      [t1, t2, g1],
      [
        // t1: judge yes/no. ada agrees on Q1, disagrees on Q2.
        checklistReview('r1', 't1', 'ada', { [Q1]: true, [Q2]: true }),
        // t2: judge yes/yes. ada agrees on both.
        checklistReview('r2', 't2', 'ada', { [Q1]: true, [Q2]: true }),
        // g1: judge no/yes. ada agrees on Q1 only; a question the judge never answered is not compared.
        checklistReview('r3', 'g1', 'ada', { [Q1]: false, [Q2]: false, 'Other?': true }),
      ],
    );
    expect(agreement).toEqual({
      reviewers: ['ada'],
      questions: [
        {
          taskId: 'refund',
          question: Q1,
          withJudge: { compared: 2, agreed: 2 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
        {
          taskId: 'refund',
          question: Q2,
          withJudge: { compared: 2, agreed: 1 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
        {
          taskId: 'greeting',
          question: Q1,
          withJudge: { compared: 1, agreed: 1 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
        {
          taskId: 'greeting',
          question: Q2,
          withJudge: { compared: 1, agreed: 0 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
        {
          taskId: 'greeting',
          question: 'Other?',
          withJudge: { compared: 0, agreed: 0 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
      ],
      comparisons: [],
    });
  });

  it('counts every pair of reviewers of the same run, with only their latest review', () => {
    const agreement = agreementOf(
      [t1],
      [
        checklistReview('r1', 't1', 'ada', { [Q1]: false }, '2026-09-27T11:00:00.000Z'),
        checklistReview('r2', 't1', 'ada', { [Q1]: true }, '2026-09-27T12:00:00.000Z'),
        checklistReview('r3', 't1', 'bo', { [Q1]: true }),
        checklistReview('r4', 't1', 'cy', { [Q1]: false }),
      ],
    );
    // Pairs: ada-bo agree, ada-cy disagree, bo-cy disagree. Judge yes: ada, bo agree; cy not.
    expect(agreement?.reviewers).toEqual(['ada', 'bo', 'cy']);
    expect(agreement?.questions).toEqual([
      {
        taskId: 'refund',
        question: Q1,
        withJudge: { compared: 3, agreed: 2 },
        betweenReviewers: { compared: 3, agreed: 1 },
      },
    ]);
  });

  it('compares preferences on the pair the judge compared', () => {
    const won = makeRun({
      id: 't1',
      taskId: 'refund',
      arm: 'rules',
      grades: [comparisonGrade(true)],
    });
    const lost = makeRun({
      id: 't2',
      taskId: 'refund',
      arm: 'rules',
      grades: [comparisonGrade(false)],
    });
    const agreement = agreementOf(
      [won, lost],
      [
        // The judge preferred t1 over run-0: ada agrees, bo does not.
        comparisonReview('r1', 't1', 'ada', true, 'run-0'),
        comparisonReview('r2', 't1', 'bo', false, 'run-0'),
        // The judge preferred run-0 over t2: ada agrees.
        comparisonReview('r3', 't2', 'ada', false, 'run-0'),
        // The judge never compared t2 with c9: only the reviewers' pair counts.
        comparisonReview('r4', 't2', 'ada', true, 'c9'),
        comparisonReview('r5', 't2', 'bo', true, 'c9'),
      ],
    );
    expect(agreement?.comparisons).toEqual([
      {
        taskId: 'refund',
        withJudge: { compared: 3, agreed: 2 },
        betweenReviewers: { compared: 2, agreed: 1 },
      },
    ]);
    expect(agreement?.questions).toEqual([]);
  });
});
