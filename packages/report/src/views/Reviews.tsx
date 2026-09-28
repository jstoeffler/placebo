import type { Review, Run } from '@placebo-eval/core/results';
import { useReport } from '../context.js';
import type { RunFilter } from '../data/model.js';
import { formatTimestamp } from '../format.js';
import { Answers, Opponent } from './Grades.js';

/**
 * The reviews of a run, in the run detail's review slot: its checklist reviews, and every
 * comparison it took part in on either side. Nothing when it has none.
 */
export function RunReviews({ run, filter }: { readonly run: Run; readonly filter: RunFilter }) {
  const { index } = useReport();
  const reviews = index.results.reviews.filter(
    (review) =>
      review.runId === run.id ||
      (review.answer.type === 'comparison' && review.answer.opponentRunId === run.id),
  );
  if (reviews.length === 0) return null;
  return (
    <section className="reviews" data-slot="review" aria-labelledby="reviews-heading">
      <h3 id="reviews-heading">Reviews</h3>
      <ol className="review-list">
        {reviews.map((review) => (
          <li key={review.id} className="review-entry">
            <p className="review-by">
              <strong>{review.reviewer}</strong>{' '}
              <span className="quiet">{formatTimestamp(review.createdAt)}</span>
            </p>
            <ReviewBody review={review} run={run} filter={filter} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReviewBody(props: {
  readonly review: Review;
  readonly run: Run;
  readonly filter: RunFilter;
}) {
  const { answer } = props.review;
  if (answer.type === 'checklist') return <Answers answers={answer.answers} />;
  const own = props.review.runId === props.run.id;
  const other = own ? answer.opponentRunId : props.review.runId;
  const preferredThis = own === answer.won;
  return (
    <>
      <Opponent runId={other} filter={props.filter} />
      <p>{preferredThis ? 'Preferred this run.' : 'Preferred the other run.'}</p>
      {answer.note !== undefined && <p className="reasoning">{answer.note}</p>}
    </>
  );
}
