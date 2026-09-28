import { request } from 'node:http';
import {
  assembleResults,
  type Clock,
  createSeededRandom,
  MemoryRunStore,
  type Run,
  Suite,
} from '@placebo-eval/core';
import { Results, ReviewSession } from '@placebo-eval/core/results';
import {
  commandGrade,
  comparisonGrade,
  makeExperiment,
  makeRun,
  sampleGrades,
} from '@placebo-eval/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESULTS_PLACEHOLDER } from '../report-files.js';
import { type ReviewServer, startReviewServer } from './server.js';

const VARIANT = 'terse-rules';
const TASK = 'refund-rounding';
const Q1 = 'Rounds half up?';
const Q2 = 'Keeps signature?';
const Q3 = 'Would you merge it?';
const TEMPLATE = `<html><script id="placebo-results" type="application/json">${RESULTS_PLACEHOLDER}</script></html>`;
const clock: Clock = { now: () => new Date('2026-09-28T09:00:00.000Z') };

const suite = Suite.parse({
  commit: '3f9a1c2e',
  model: 'claude-sonnet-5',
  judgeModel: 'claude-opus-5-5',
  variants: { [VARIANT]: { patch: `variants/${VARIANT}.patch` } },
  tasks: [
    {
      id: TASK,
      prompt: 'Fix the rounding.',
      graders: [
        { type: 'command', run: 'pnpm vitest run' },
        { type: 'checklist', questions: 'tasks/refund/checklist.md' },
        { type: 'comparison' },
      ],
      review: { questions: 'tasks/refund/review.md' },
    },
  ],
});
const encoder = new TextEncoder();
const files = new Map([
  ['tasks/refund/checklist.md', encoder.encode(`- ${Q1}\n- ${Q2}\n`)],
  ['tasks/refund/review.md', encoder.encode(`- ${Q3}\n- ${Q1}\n`)],
]);
const experiment = makeExperiment({
  id: 'exp-1',
  taskIds: [TASK],
  runsPerTask: 2,
  arms: [
    { kind: 'control' },
    { kind: 'treatment', variant: VARIANT, patch: `variants/${VARIANT}.patch` },
  ],
});

/** Each run's change holds its own marker word, so a test can tell which run it is shown. */
const MARKERS = ['alpha', 'bravo', 'charlie', 'delta'] as const;
const runs: Run[] = [
  ['control', 1],
  ['control', 2],
  [VARIANT, 1],
  [VARIANT, 2],
].map(([arm, n], i) => {
  const marker = MARKERS[i] ?? 'none';
  const treatment = arm !== 'control';
  const judgeWon = n === 1;
  return makeRun({
    id: `exp-1-${TASK}-${String(arm)}-${String(n)}`,
    experimentId: 'exp-1',
    taskId: TASK,
    arm: String(arm),
    change: {
      diff: `--- a/src/money.ts\n+++ b/src/money.ts\n+// ${marker}\n`,
      files: ['src/money.ts'],
      bytes: 50,
    },
    grades: [
      commandGrade(true),
      sampleGrades[1],
      ...(treatment
        ? [
            {
              ...(comparisonGrade(judgeWon) as object),
              detail: {
                ...(comparisonGrade(judgeWon) as { detail: object }).detail,
                opponentRunId: `exp-1-${TASK}-control-1`,
              },
            },
          ]
        : []),
    ],
  });
});
const runByMarker = new Map(runs.map((run, i) => [MARKERS[i], run]));

function runShown(diff: string): Run {
  const marker = MARKERS.find((word) => diff.includes(`// ${word}`));
  const run = marker === undefined ? undefined : runByMarker.get(marker);
  if (run === undefined) throw new Error(`no marker in ${diff}`);
  return run;
}

let store: MemoryRunStore;
let server: ReviewServer;
let reviewIds: number;

beforeEach(async () => {
  store = new MemoryRunStore();
  await store.saveExperiment(experiment);
  for (const run of runs) await store.save(run);
  const results = assembleResults({
    experiment,
    runs,
    reviews: [],
    suite,
    margins: suite.margins,
    random: createSeededRandom(experiment.seed),
    clock,
    resamples: 50,
  });
  reviewIds = 0;
  server = await startReviewServer({
    store,
    experiment,
    suite,
    results,
    files,
    template: TEMPLATE,
    random: createSeededRandom(3),
    clock,
    newReviewId: () => `review-${String(++reviewIds)}`,
  });
});

afterEach(async () => {
  await server.close();
});

const api = (path: string) => new URL(path, server.url);

async function session(reviewer = 'julien'): Promise<ReviewSession> {
  const response = await fetch(api(`/api/session?reviewer=${reviewer}`));
  expect(response.status).toBe(200);
  return ReviewSession.parse(await response.json());
}

function post(path: string, body: unknown, type = 'application/json'): Promise<Response> {
  return fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function checklistAnswer(token: string, yes = true, reviewer = 'julien') {
  return {
    token,
    reviewer,
    answer: {
      type: 'checklist',
      answers: [Q1, Q2, Q3].map((question) => ({ question, yes })),
    },
  };
}

/** Everything that would unblind a reviewer if it appeared in what they are served. */
function unblinding(): string[] {
  return [
    VARIANT,
    `variants/${VARIANT}.patch`,
    ...runs.map((run) => run.id),
    'control',
    'treatment',
    'helps',
    'harms',
    'placebo',
    'no_evidence',
    '"means"',
    '"breakdown"',
    '"verdictCards"',
    '"arm"',
    '"grades"',
  ];
}

describe('review server', () => {
  it('serves a session with no arm, variant, run id, verdict or per-arm mean', async () => {
    const response = await fetch(api('/api/session?reviewer=julien'));
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await response.text();
    for (const word of unblinding()) expect(text, word).not.toContain(word);
    const data = ReviewSession.parse(JSON.parse(text));
    expect(data).toMatchObject({ experimentId: 'exp-1', reviewer: 'julien', taskCount: 1 });
    expect(data.items).toHaveLength(4);
    expect(data.comparisons).toHaveLength(2);
    expect(data.items[0]?.questions).toEqual([Q1, Q2, Q3]);
    expect(data.items[0]?.checks).toEqual([
      { command: 'pnpm vitest run', exitCode: 0, stdout: 'ok', stderr: '' },
    ]);
    expect(new Set([...data.items, ...data.comparisons].map((entry) => entry.token)).size).toBe(6);
    expect(server.itemCount).toBe(4);
    expect(server.comparisonCount).toBe(2);
  });

  it('serves the report in review mode with the same blinded session embedded', async () => {
    const response = await fetch(api('/'));
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    const html = await response.text();
    const tag =
      /<script data-mode="review" id="placebo-results" type="application\/json">(.*)<\/script>/s.exec(
        html,
      );
    const json = tag?.[1] ?? '';
    expect(json).not.toBe('');
    for (const word of unblinding()) expect(json, word).not.toContain(word);
    const embedded = ReviewSession.parse(JSON.parse(json));
    expect(embedded.reviewer).toBeNull();
    expect(embedded.items).toHaveLength(4);
  });

  it('saves a checklist answer as a review of the run its token stands for', async () => {
    const [item] = (await session()).items;
    if (item === undefined) throw new Error('no item');
    const response = await post('/api/answers', checklistAnswer(item.token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true, remaining: 5 });
    expect(await store.listReviews()).toEqual([
      {
        id: 'review-1',
        runId: runShown(item.change.diff).id,
        reviewer: 'julien',
        createdAt: '2026-09-28T09:00:00.000Z',
        answer: checklistAnswer(item.token).answer,
      },
    ]);
    const after = await session();
    expect(after.items.map((entry) => entry.answered)).toEqual([false, false, false, true]);
    expect(after.items[3]?.token).toBe(item.token);
    expect((await session('bo')).items.every((entry) => !entry.answered)).toBe(true);
    expect(server.saved()).toBe(1);
  });

  it('resolves a comparison to the treatment run, its control opponent and who won', async () => {
    const { comparisons } = await session();
    for (const [index, pair] of comparisons.entries()) {
      const a = runShown(pair.a.change.diff);
      const b = runShown(pair.b.change.diff);
      expect([a.arm.kind, b.arm.kind].sort()).toEqual(['control', 'treatment']);
      const preferred = index === 0 ? 'a' : 'b';
      const response = await post('/api/answers', {
        token: pair.token,
        reviewer: 'julien',
        answer: { type: 'comparison', preferred, reason: 'Smaller.' },
      });
      expect(response.status).toBe(200);
      const [treatment, control] = a.arm.kind === 'treatment' ? [a, b] : [b, a];
      const winner = preferred === 'a' ? a : b;
      const review = (await store.listReviews()).at(-1);
      expect(review).toMatchObject({
        runId: treatment.id,
        answer: {
          type: 'comparison',
          opponentRunId: control.id,
          won: winner.id === treatment.id,
          note: 'Smaller.',
        },
      });
      // The pair the judge compared: the treatment run against control run 1.
      expect(control.id).toBe(`exp-1-${TASK}-control-1`);
    }
  });

  it('refuses a second answer to the same token by the same reviewer', async () => {
    const [item] = (await session()).items;
    if (item === undefined) throw new Error('no item');
    expect((await post('/api/answers', checklistAnswer(item.token))).status).toBe(200);
    const again = await post('/api/answers', checklistAnswer(item.token, false));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: `julien has already answered ${item.token}` });
    expect((await post('/api/answers', checklistAnswer(item.token, false, 'bo'))).status).toBe(200);
  });

  it('answers 400 on invalid bodies and 404 on unknown tokens', async () => {
    const { items, comparisons } = await session();
    const item = items[0];
    const pair = comparisons[0];
    if (item === undefined || pair === undefined) throw new Error('empty session');
    const cases: [Response, number, string][] = [
      [await post('/api/answers', '{', 'application/json'), 400, 'the body is not valid JSON'],
      [
        await post('/api/answers', checklistAnswer(item.token), 'text/plain'),
        400,
        'send the body as Content-Type: application/json',
      ],
      [
        await post('/api/answers', { token: item.token, reviewer: '', answer: {} }),
        400,
        'invalid answer: reviewer: Too small: expected string to have >=1 characters',
      ],
      [
        await post('/api/answers', {
          ...checklistAnswer(item.token),
          answer: { type: 'checklist', answers: [{ question: Q1, yes: true }] },
        }),
        400,
        'answer each of the 3 questions once',
      ],
      [
        await post('/api/answers', checklistAnswer(pair.token)),
        400,
        `${pair.token} is a comparison; say which of a and b is better`,
      ],
      [
        await post('/api/answers', {
          token: item.token,
          reviewer: 'julien',
          answer: { type: 'comparison', preferred: 'a' },
        }),
        400,
        `${item.token} is a run; answer its checklist`,
      ],
      [await post('/api/answers', checklistAnswer('nope')), 404, 'unknown token nope'],
    ];
    for (const [response, status, error] of cases) {
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({ error });
    }
    expect(await store.listReviews()).toEqual([]);
  });

  it('hides results until finish, then answers results with reviews and agreement', async () => {
    const hidden = await fetch(api('/api/results'));
    expect(hidden.status).toBe(403);
    const { items, comparisons } = await session();
    for (const item of items) await post('/api/answers', checklistAnswer(item.token));
    const pair = comparisons[0];
    if (pair === undefined) throw new Error('no pair');
    await post('/api/answers', {
      token: pair.token,
      reviewer: 'julien',
      answer: { type: 'comparison', preferred: 'a' },
    });

    const finished = await post('/api/finish', {});
    expect(finished.status).toBe(200);
    const results = Results.parse(await finished.json());
    expect(results.reviews).toHaveLength(5);
    expect(results.agreement?.reviewers).toEqual(['julien']);
    // The judge said yes to Q1 and Q2 on every run; so did julien.
    expect(results.agreement?.questions).toEqual([
      {
        taskId: TASK,
        question: Q1,
        withJudge: { compared: 4, agreed: 4 },
        betweenReviewers: { compared: 0, agreed: 0 },
      },
      {
        taskId: TASK,
        question: 'Keeps signature?',
        withJudge: { compared: 4, agreed: 4 },
        betweenReviewers: { compared: 0, agreed: 0 },
      },
      {
        taskId: TASK,
        question: Q3,
        withJudge: { compared: 0, agreed: 0 },
        betweenReviewers: { compared: 0, agreed: 0 },
      },
    ]);
    expect(
      results.agreement?.comparisons.map((row) => [row.taskId, row.withJudge.compared]),
    ).toEqual([[TASK, 1]]);

    const shown = await fetch(api('/api/results'));
    expect(shown.status).toBe(200);
    expect(Results.parse(await shown.json()).reviews).toHaveLength(5);
    const late = await post('/api/answers', checklistAnswer(items[0]?.token ?? '', true, 'bo'));
    expect(late.status).toBe(409);
  });

  it('rejects requests addressed to any host but localhost, and foreign origins', async () => {
    const { port } = new URL(server.url);
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port, path: '/api/session', headers },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    expect(await status({ Host: `evil.example:${port}` })).toBe(403);
    expect(await status({ Host: `localhost:${port}` })).toBe(200);
    expect(await status({ Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' })).toBe(403);
    expect(await status({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` })).toBe(
      200,
    );
  });

  it('answers 404 on unknown paths and 405 on wrong methods', async () => {
    expect((await fetch(api('/nothing'))).status).toBe(404);
    expect((await fetch(api('/api/answers'))).status).toBe(405);
  });
});
