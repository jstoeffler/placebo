// @vitest-environment happy-dom
import type { Agreement, Results, ReviewSession } from '@placebo-eval/core/results';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { loadResults } from '../data/load.js';
import { fixture, fixtureText, reviewFixture } from '../testing/fixtures.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

let calls: Call[];
let session: ReviewSession;
let finished: Results;

const agreement: Agreement = {
  reviewers: ['Ada'],
  questions: [
    {
      taskId: 'fix-refund-rounding' as never,
      question: 'Is the refunded amount capped at the captured amount?',
      withJudge: { compared: 4, agreed: 3 },
      betweenReviewers: { compared: 0, agreed: 0 },
    },
  ],
  comparisons: [
    {
      taskId: 'fix-refund-rounding' as never,
      withJudge: { compared: 2, agreed: 1 },
      betweenReviewers: { compared: 0, agreed: 0 },
    },
  ],
};

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
  calls = [];
  session = reviewFixture();
  finished = { ...fixture('rich'), agreement };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url: input, method, body });
      if (input.startsWith('/api/session')) {
        const reviewer = new URLSearchParams(input.split('?')[1]).get('reviewer');
        return Promise.resolve(json(200, { ...session, reviewer }));
      }
      if (input === '/api/answers')
        return Promise.resolve(json(200, { saved: true, remaining: 1 }));
      if (input === '/api/finish') return Promise.resolve(json(200, finished));
      return Promise.resolve(json(404, { error: 'no route' }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderReview() {
  return render(<App loaded={loadResults(fixtureText('review'), 'review')} />);
}

async function startAs(name: string) {
  const user = userEvent.setup();
  renderReview();
  await user.type(screen.getByLabelText('Your name'), name);
  await user.click(screen.getByRole('button', { name: 'Start reviewing' }));
  await waitFor(() => {
    expect(screen.getByRole('navigation', { name: 'Review queue' })).toBeDefined();
  });
  return user;
}

const total = () => reviewFixture().items.length + reviewFixture().comparisons.length;

describe('review mode', () => {
  it('asks the name once, keeps it, and shows the queue without any arm', async () => {
    await startAs('Ada');
    expect(window.localStorage.getItem('placebo-reviewer')).toBe('Ada');
    expect(calls[0]).toMatchObject({ url: '/api/session?reviewer=Ada', method: 'GET' });
    const queue = screen.getByRole('navigation', { name: 'Review queue' });
    expect(within(queue).getAllByRole('button')).toHaveLength(total());
    expect(screen.getByText(`1 of ${String(total())} reviewed`)).toBeDefined();
    expect(screen.getByText('Ada')).toBeDefined();
    const text = document.body.textContent;
    for (const word of ['control', 'treatment', 'tests-first', 'hidden arm', 'helps', 'harms'])
      expect(text).not.toContain(word);
    cleanup();
    // The next visit skips the question.
    renderReview();
    await waitFor(() => {
      expect(screen.getByRole('navigation', { name: 'Review queue' })).toBeDefined();
    });
    expect(screen.queryByLabelText('Your name')).toBeNull();
  });

  it('answers the checklist with y and n and saves with Enter, then moves on', async () => {
    const user = await startAs('Ada');
    const first = session.items[0];
    if (first === undefined) throw new Error('no item');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(`${first.taskId} run 1`);
    const save = screen.getByRole('button', { name: 'Save and next' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard('y');
    await user.keyboard('n');
    await user.type(
      screen.getByLabelText(`Note on "${first.questions[1] ?? ''}" (optional)`),
      'Close.',
    );
    // Typing in a note never answers a question.
    expect(screen.getByText('1 to answer. y or n answers the focused question.')).toBeDefined();
    await user.click(document.body);
    await user.keyboard('y');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(calls.some((call) => call.url === '/api/answers')).toBe(true);
    });
    expect(calls.find((call) => call.url === '/api/answers')).toEqual({
      url: '/api/answers',
      method: 'POST',
      body: {
        token: first.token,
        reviewer: 'Ada',
        answer: {
          type: 'checklist',
          answers: [
            { question: first.questions[0], yes: true },
            { question: first.questions[1], yes: false, note: 'Close.' },
            { question: first.questions[2], yes: true },
          ],
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByText(`2 of ${String(total())} reviewed`)).toBeDefined();
    });
    const second = session.items[1];
    const ordinal = session.items
      .slice(0, 2)
      .filter((item) => item.taskId === second?.taskId).length;
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(
      `${second?.taskId ?? ''} run ${String(ordinal)}`,
    );
  });

  it('compares a and b and posts the preferred side with the reason', async () => {
    const user = await startAs('Ada');
    const pair = session.comparisons[0];
    if (pair === undefined) throw new Error('no pair');
    const queue = screen.getByRole('navigation', { name: 'Review queue' });
    await user.click(within(queue).getAllByRole('button', { name: /pair 1/ })[0]!);
    expect(screen.getByRole('region', { name: 'Result a' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Result b' })).toBeDefined();
    await user.keyboard('b');
    await user.type(screen.getByLabelText('Why (optional)'), 'Smaller change.');
    await user.click(screen.getByRole('button', { name: 'Save and next' }));
    await waitFor(() => {
      expect(calls.find((call) => call.url === '/api/answers')?.body).toEqual({
        token: pair.token,
        reviewer: 'Ada',
        answer: { type: 'comparison', preferred: 'b', reason: 'Smaller change.' },
      });
    });
  });

  it('shows why a save failed', async () => {
    const user = await startAs('Ada');
    vi.mocked(fetch).mockResolvedValueOnce(json(409, { error: 'Ada has already answered x' }));
    await user.keyboard('y'.repeat(session.items[0]?.questions.length ?? 0));
    await user.keyboard('{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Ada has already answered x');
  });

  it('finishes the pass and lands on the agreement with arms shown', async () => {
    const user = await startAs('Ada');
    await user.click(screen.getByRole('button', { name: 'Finish pass' }));
    const confirm = screen.getByRole('alertdialog');
    expect(within(confirm).getByRole('heading').textContent).toBe(
      `Finish with ${String(total() - 1)} not reviewed?`,
    );
    await user.click(within(confirm).getByRole('button', { name: 'Finish pass' }));
    const section = await screen.findByRole('region', { name: 'Agreement' });
    expect(calls.at(-1)).toMatchObject({ url: '/api/finish', method: 'POST' });
    expect(window.location.hash).toBe('#/agreement');
    expect(within(section).getByText('3 of 4 agree')).toBeDefined();
    expect(within(section).getByText('1 of 2 agree')).toBeDefined();
    expect(within(section).getAllByText('not compared')).toHaveLength(2);
    expect(section.querySelectorAll('.mark.agreed')).toHaveLength(4);
    // Agreement follows the verdict cards, and the arms are named again.
    const card = screen.getByRole('region', { name: /^none vs control/ });
    expect(card.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('reviews in the report', () => {
  it('lists the reviews of a run in its review slot', () => {
    const results = fixture('rich');
    const review = results.reviews[0];
    if (review === undefined) throw new Error('no review');
    window.location.hash = `#/runs/${review.runId}`;
    render(<App loaded={loadResults(JSON.stringify(results))} />);
    const slot = screen.getByRole('region', { name: 'Reviews' });
    expect(slot.dataset.slot).toBe('review');
    expect(within(slot).getByText(review.reviewer)).toBeDefined();
    if (review.answer.type !== 'checklist') throw new Error('expected a checklist review');
    expect(within(slot).getAllByRole('listitem').length).toBeGreaterThan(
      review.answer.answers.length,
    );
  });

  it('shows a comparison review on both runs', () => {
    const results = fixture('minimal');
    const [control, treatment] = [
      results.runs.find((run) => run.arm.kind === 'control'),
      results.runs.find((run) => run.arm.kind === 'treatment'),
    ];
    if (control === undefined || treatment === undefined) throw new Error('minimal needs both');
    const data = {
      ...results,
      reviews: [
        {
          id: 'review-1',
          runId: treatment.id,
          reviewer: 'Ada',
          createdAt: '2026-09-28T09:00:00.000Z',
          answer: { type: 'comparison', opponentRunId: control.id, won: true, note: 'Tighter.' },
        },
      ],
    };
    window.location.hash = `#/runs/${treatment.id}`;
    const { unmount } = render(<App loaded={loadResults(JSON.stringify(data))} />);
    expect(screen.getByText('Preferred this run.')).toBeDefined();
    expect(screen.getByText('Tighter.')).toBeDefined();
    unmount();
    window.location.hash = `#/runs/${control.id}`;
    render(<App loaded={loadResults(JSON.stringify(data))} />);
    expect(screen.getByText('Preferred the other run.')).toBeDefined();
  });
});
