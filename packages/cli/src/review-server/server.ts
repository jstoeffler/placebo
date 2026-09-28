import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assembleResults,
  type Clock,
  createSeededRandom,
  type Experiment,
  type Random,
  type Results,
  type Review,
  type RunStore,
  type Suite,
} from '@placebo-eval/core';
import { Review as ReviewSchema, ReviewAnswer } from '@placebo-eval/core/results';
import { withAgreement } from '../commands/shared.js';
import { embedReviewSession } from '../report-files.js';
import { createReviewPass, type Resolved } from './pass.js';

export interface ReviewServerInput {
  /** Where reviews are saved, and read to know what a reviewer has already answered. */
  readonly store: RunStore;
  readonly experiment: Experiment;
  readonly suite: Pick<Suite, 'tasks' | 'margins'>;
  /** The experiment's results as they stand: their runs are reviewed, their warnings kept. */
  readonly results: Results;
  /** The suite's files, keyed by path relative to `.placebo/`, for the question files. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The built `report.html`. */
  readonly template: string;
  /** The reviewer's name when known up front; otherwise the browser asks. */
  readonly reviewer?: string;
  /** Seeded: queue order, comparison pairing and `a`/`b` sides. */
  readonly random: Random;
  /** Stamps each review's `createdAt` and the finished results. */
  readonly clock: Clock;
  /** Makes each review's id; random by default. */
  readonly newReviewId?: () => string;
  /** 0 picks a free port. */
  readonly port?: number;
  readonly host?: string;
}

export interface ReviewServer {
  /** `http://<host>:<port>/`. */
  readonly url: string;
  /** Items and comparisons in the pass. */
  readonly itemCount: number;
  readonly comparisonCount: number;
  /** Reviews saved through this server so far. */
  saved(): number;
  close(): Promise<void>;
}

/** Largest request body accepted. */
const MAX_BODY_BYTES = 1_000_000;

/** A failed request: its status and the message sent back as `{ error }`. */
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Serves one experiment for blinded review on localhost (brief §9) with `node:http` only.
 *
 * - `GET /`: the report in review mode, with a review session in place of the results.
 * - `GET /api/session?reviewer=<name>`: the session for that reviewer, unanswered entries first.
 * - `POST /api/answers`: a `ReviewAnswer`; saved as a `Review` of the run its token stands for.
 *   Answers `{ saved: true, remaining }`; 400 on an invalid body, 404 on an unknown token, 409
 *   when the reviewer already answered it or the pass is finished.
 * - `POST /api/finish`: ends the pass and answers the full `Results`, reviews and agreement
 *   included. Only then does `GET /api/results` answer; before, it is 403.
 *
 * Every request must name the server's own host, so a page elsewhere cannot reach it through DNS
 * rebinding, and a request with an `Origin` must come from the server's own origin.
 */
export async function startReviewServer(input: ReviewServerInput): Promise<ReviewServer> {
  const host = input.host ?? '127.0.0.1';
  const pass = createReviewPass({
    experiment: input.experiment,
    runs: input.results.runs,
    suite: input.suite,
    files: input.files,
    random: input.random,
  });
  const newReviewId = input.newReviewId ?? (() => `review-${randomUUID()}`);
  let finished: Results | undefined;
  let saved = 0;
  // Answers are handled one at a time, so a double submit cannot save twice.
  let queue: Promise<unknown> = Promise.resolve();
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const allowedHosts = (port: number) =>
    new Set([`${host}:${String(port)}`, `localhost:${String(port)}`, `127.0.0.1:${String(port)}`]);

  const handle = async (request: IncomingMessage, response: ServerResponse, port: number) => {
    const hosts = allowedHosts(port);
    if (request.headers.host === undefined || !hosts.has(request.headers.host)) {
      throw new HttpError(403, 'this server answers only requests addressed to localhost');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !hosts.has(origin.replace(/^http:\/\//, ''))) {
      throw new HttpError(403, `requests from ${origin} are not accepted`);
    }
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const route = `${request.method ?? 'GET'} ${url.pathname}`;
    switch (route) {
      case 'GET /':
      case 'GET /index.html': {
        const session = pass.sessionFor(input.reviewer ?? null, await input.store.listReviews());
        send(
          response,
          200,
          'text/html; charset=utf-8',
          embedReviewSession(input.template, session),
        );
        return;
      }
      case 'GET /api/session': {
        const reviewer = url.searchParams.get('reviewer')?.trim() ?? '';
        const session = pass.sessionFor(
          reviewer === '' ? null : reviewer,
          await input.store.listReviews(),
        );
        sendJson(response, 200, session);
        return;
      }
      case 'POST /api/answers': {
        const body = await readJson(request);
        const answered = await serially(() => saveAnswer(body));
        sendJson(response, 200, answered);
        return;
      }
      case 'POST /api/finish': {
        await readJson(request);
        const results = await serially(finish);
        sendJson(response, 200, results);
        return;
      }
      case 'GET /api/results':
        if (finished === undefined) {
          throw new HttpError(403, 'results stay hidden until the review pass is finished');
        }
        sendJson(response, 200, finished);
        return;
      default:
        throw new HttpError(
          [
            '/',
            '/index.html',
            '/api/session',
            '/api/answers',
            '/api/finish',
            '/api/results',
          ].includes(url.pathname)
            ? 405
            : 404,
          `no route ${route}`,
        );
    }
  };

  const saveAnswer = async (body: unknown): Promise<{ saved: true; remaining: number }> => {
    const parsed = ReviewAnswer.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new HttpError(
        400,
        `invalid answer: ${issue === undefined ? 'unknown problem' : `${issue.path.join('.') || '(root)'}: ${issue.message}`}`,
      );
    }
    const { token, reviewer, answer } = parsed.data;
    if (finished !== undefined) throw new HttpError(409, 'the review pass is finished');
    const resolved = pass.resolve(token);
    if (resolved === undefined) throw new HttpError(404, `unknown token ${token}`);
    const reviews = await input.store.listReviews();
    if (alreadyReviewed(resolved, reviewer, reviews)) {
      throw new HttpError(409, `${reviewer} has already answered ${token}`);
    }
    const base = { id: newReviewId(), reviewer, createdAt: input.clock.now().toISOString() };
    let review: Review;
    if (resolved.type === 'item') {
      if (answer.type !== 'checklist') {
        throw new HttpError(400, `${token} is a run; answer its checklist`);
      }
      const given = answer.answers.map((entry) => entry.question);
      const expected = resolved.questions;
      if (
        given.length !== expected.length ||
        new Set(given).size !== given.length ||
        !given.every((question) => expected.includes(question))
      ) {
        throw new HttpError(400, `answer each of the ${String(expected.length)} questions once`);
      }
      review = ReviewSchema.parse({ ...base, runId: resolved.runId, answer });
    } else {
      if (answer.type !== 'comparison') {
        throw new HttpError(400, `${token} is a comparison; say which of a and b is better`);
      }
      review = ReviewSchema.parse({
        ...base,
        runId: resolved.treatmentRunId,
        answer: {
          type: 'comparison',
          opponentRunId: resolved.controlRunId,
          won: answer.preferred === resolved.treatmentSide,
          ...(answer.reason === undefined || answer.reason.trim() === ''
            ? {}
            : { note: answer.reason }),
        },
      });
    }
    await input.store.saveReview(review);
    saved += 1;
    return { saved: true, remaining: pass.remaining(reviewer, [...reviews, review]) };
  };

  const finish = async (): Promise<Results> => {
    const reviews = await input.store.listReviews();
    finished = withAgreement(
      assembleResults({
        experiment: input.experiment,
        runs: input.results.runs,
        reviews,
        suite: input.suite,
        margins: input.suite.margins,
        random: createSeededRandom(input.experiment.seed),
        clock: input.clock,
        warnings: input.results.warnings,
      }),
    );
    return finished;
  };

  let port = 0;
  const server = createServer((request, response) => {
    handle(request, response, port).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${String(port)}/`,
    itemCount: pass.itemCount,
    comparisonCount: pass.comparisonCount,
    saved: () => saved,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function alreadyReviewed(
  resolved: Resolved,
  reviewer: string,
  reviews: readonly Review[],
): boolean {
  return reviews.some((review) => {
    if (review.reviewer !== reviewer) return false;
    if (resolved.type === 'item') {
      return review.runId === resolved.runId && review.answer.type === 'checklist';
    }
    return (
      review.runId === resolved.treatmentRunId &&
      review.answer.type === 'comparison' &&
      review.answer.opponentRunId === resolved.controlRunId
    );
  });
}

/** The request body as JSON; 400 unless it is JSON sent as `application/json`. */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new HttpError(400, 'send the body as Content-Type: application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'the body is too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'the body is not valid JSON');
  }
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, data: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(data));
}
