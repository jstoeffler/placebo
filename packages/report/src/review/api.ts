import { Results, type ReviewAnswer, ReviewSession } from '@placebo-eval/core/results';

/** What `POST /api/answers` answers. */
export interface Saved {
  readonly saved: true;
  /** Items and comparisons this reviewer has not reviewed yet. */
  readonly remaining: number;
}

/** A request `placebo review` refused, with the reason it gave. */
class ReviewApiError extends Error {
  override readonly name = 'ReviewApiError';
}

/** The review server's API, as review mode uses it (see the cli's review server). */
export const reviewApi = {
  /** The session for `reviewer`: what they have not reviewed first. */
  async session(reviewer: string): Promise<ReviewSession> {
    const response = await fetch(`/api/session?reviewer=${encodeURIComponent(reviewer)}`);
    return ReviewSession.parse(await bodyOf(response));
  },

  async answer(answer: ReviewAnswer): Promise<Saved> {
    return (await bodyOf(await post('/api/answers', answer))) as Saved;
  },

  /** Ends the pass; the full results, arms, reviews and agreement included. */
  async finish(): Promise<Results> {
    return Results.parse(await bodyOf(await post('/api/finish', {})));
  },
};

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<unknown> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ReviewApiError(
      `the review server answered ${String(response.status)} without JSON; is placebo review still running?`,
    );
  }
  if (!response.ok) {
    const error =
      typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `status ${String(response.status)}`;
    throw new ReviewApiError(error);
  }
  return data;
}
