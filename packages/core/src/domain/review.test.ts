import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { sampleChange, sampleEvents, sampleResults } from '../testing/fixtures.js';
import { Results } from './results.js';
import { Agreement, ReviewAnswer, ReviewSession } from './review.js';

const check = { command: 'pnpm vitest run', exitCode: 1, stdout: 'FAIL', stderr: '' };

const session = {
  experimentId: 'exp-1',
  reviewer: 'julien',
  taskCount: 1,
  items: [
    {
      token: 'k7',
      taskId: 'refund-rounding',
      prompt: 'Fix the rounding.',
      change: sampleChange,
      checks: [check],
      events: sampleEvents,
      questions: ['Rounds half up?'],
      answered: false,
    },
  ],
  comparisons: [
    {
      token: 'p2',
      taskId: 'refund-rounding',
      prompt: 'Fix the rounding.',
      a: { change: sampleChange, checks: [check] },
      b: { change: sampleChange, checks: [] },
      answered: true,
    },
  ],
};

function issuesOf(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('expected a validation error');
  return result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/** Every property name anywhere in a JSON Schema. */
function propertyNames(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const entry of schema) propertyNames(entry, into);
  } else if (typeof schema === 'object' && schema !== null) {
    for (const [key, value] of Object.entries(schema) as [string, unknown][]) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        for (const name of Object.keys(value)) into.add(name);
      }
      propertyNames(value, into);
    }
  }
  return into;
}

describe('ReviewSession', () => {
  it('accepts a blinded session, reviewer null until named', () => {
    expect(ReviewSession.parse(session)).toEqual(session);
    expect(ReviewSession.parse({ ...session, reviewer: null }).reviewer).toBeNull();
  });

  it('has no field that could carry an arm, a run id, a grade or a measurement', () => {
    const names = propertyNames(z.toJSONSchema(ReviewSession));
    for (const forbidden of [
      'arm',
      'arms',
      'variant',
      'patch',
      'runId',
      'opponentRunId',
      'grades',
      'measurements',
      'verdictCards',
      'breakdown',
      'means',
      'runFolder',
      'key',
    ])
      expect(names.has(forbidden), forbidden).toBe(false);
  });

  it('rejects any extra field, so none can slip in', () => {
    const [item] = session.items;
    expect(
      issuesOf(ReviewSession, { ...session, items: [{ ...item, arm: { kind: 'control' } }] }),
    ).toEqual(['items.0: Unrecognized key: "arm"']);
    expect(issuesOf(ReviewSession, { ...session, items: [{ ...item, questions: [] }] })).toEqual([
      'items.0.questions: Too small: expected array to have >=1 items',
    ]);
  });
});

describe('ReviewAnswer', () => {
  it('accepts checklist answers and a preferred side', () => {
    const checklist = {
      token: 'k7',
      reviewer: 'julien',
      answer: { type: 'checklist', answers: [{ question: 'Rounds half up?', yes: true }] },
    };
    expect(ReviewAnswer.parse(checklist)).toEqual(checklist);
    const comparison = {
      token: 'p2',
      reviewer: 'julien',
      answer: { type: 'comparison', preferred: 'b', reason: 'Smaller.' },
    };
    expect(ReviewAnswer.parse(comparison)).toEqual(comparison);
  });

  it('names what is wrong', () => {
    expect(
      issuesOf(ReviewAnswer, {
        token: '',
        reviewer: '  ',
        answer: { type: 'comparison', preferred: 'c' },
      }),
    ).toEqual([
      'token: Too small: expected string to have >=1 characters',
      'reviewer: Too small: expected string to have >=1 characters',
      'answer.preferred: Invalid option: expected one of "a"|"b"',
    ]);
    expect(
      issuesOf(ReviewAnswer, {
        token: 'k7',
        reviewer: 'julien',
        answer: { type: 'checklist', answers: [] },
      }),
    ).toEqual(['answer.answers: Too small: expected array to have >=1 items']);
  });
});

describe('Agreement in Results', () => {
  it('is optional and validated when present', () => {
    const agreement = {
      reviewers: ['julien'],
      questions: [
        {
          taskId: 'refund-rounding',
          question: 'Rounds half up?',
          withJudge: { compared: 2, agreed: 1 },
          betweenReviewers: { compared: 0, agreed: 0 },
        },
      ],
      comparisons: [],
    };
    expect(Agreement.parse(agreement)).toEqual(agreement);
    expect(Results.parse({ ...sampleResults, agreement }).agreement).toEqual(agreement);
    expect(Results.parse(sampleResults).agreement).toBeUndefined();
    expect(
      issuesOf(Results, {
        ...sampleResults,
        agreement: { ...agreement, comparisons: [{ taskId: 'refund-rounding' }] },
      }),
    ).toEqual([
      'agreement.comparisons.0.withJudge: Invalid input: expected object, received undefined',
      'agreement.comparisons.0.betweenReviewers: Invalid input: expected object, received undefined',
    ]);
  });
});
