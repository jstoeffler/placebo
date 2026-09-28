import type {
  ChecklistAnswer,
  Results,
  ReviewAnswer,
  ReviewComparison,
  ReviewItem,
  ReviewSession,
} from '@placebo-eval/core/results';
import { useEffect, useState, type SubmitEvent } from 'react';
import { AGREEMENT_HASH } from '../views/Agreement.js';
import { Frame } from '../views/Frame.js';
import { reviewApi } from './api.js';
import { ComparisonView } from './ComparisonView.js';
import { ItemView } from './ItemView.js';
import { IDLE, type SaveState } from './shared.js';

/** Where the reviewer's name is kept between visits. */
const REVIEWER_KEY = 'placebo-reviewer';

type Entry =
  | {
      readonly kind: 'item';
      readonly token: string;
      readonly label: string;
      readonly item: ReviewItem;
    }
  | {
      readonly kind: 'comparison';
      readonly token: string;
      readonly label: string;
      readonly comparison: ReviewComparison;
    };

/** The queue: runs, then comparisons, each numbered within its task in the order served. */
function entriesOf(session: ReviewSession): Entry[] {
  const seen = new Map<string, number>();
  const next = (key: string) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  };
  return [
    ...session.items.map((item): Entry => ({
      kind: 'item',
      token: item.token,
      label: `run ${String(next(`run ${item.taskId}`))}`,
      item,
    })),
    ...session.comparisons.map((comparison): Entry => ({
      kind: 'comparison',
      token: comparison.token,
      label: `pair ${String(next(`pair ${comparison.taskId}`))}`,
      comparison,
    })),
  ];
}

const answeredOf = (entry: Entry) =>
  entry.kind === 'item' ? entry.item.answered : entry.comparison.answered;

function storedReviewer(): string | null {
  try {
    const name = window.localStorage.getItem(REVIEWER_KEY)?.trim() ?? '';
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

function storeReviewer(name: string): void {
  try {
    window.localStorage.setItem(REVIEWER_KEY, name);
  } catch {
    // Private mode: the name lasts for this page only.
  }
}

function messageOf(error: unknown): string {
  if (error instanceof TypeError) {
    return 'Cannot reach the review server. Is placebo review still running?';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Review mode (`placebo review`): asks the reviewer's name once, then walks them through the
 * blinded queue of runs and comparisons. The session carries no arm, so nothing here can show
 * one. Finishing the pass hands the full results to `onFinished`.
 */
export function ReviewApp(props: {
  readonly session: ReviewSession;
  readonly onFinished: (results: Results) => void;
}) {
  const [session, setSession] = useState(props.session);
  const [reviewer, setReviewer] = useState<string | null>(
    () => props.session.reviewer ?? storedReviewer(),
  );
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const entries = entriesOf(session);
  const [selected, setSelected] = useState<string | undefined>(
    () => entries.find((entry) => !answeredOf(entry))?.token ?? entries[0]?.token,
  );
  const [save, setSave] = useState<SaveState>(IDLE);
  const [confirming, setConfirming] = useState(false);
  const [finishing, setFinishing] = useState(false);

  // The embedded session is for the name given on the command line, if any; a name kept in the
  // browser needs its own, so what that reviewer already answered shows as answered.
  useEffect(() => {
    if (reviewer === null || reviewer === session.reviewer) return;
    let current = true;
    setLoading(true);
    reviewApi
      .session(reviewer)
      .then((fresh) => {
        if (!current) return;
        setSession(fresh);
        const list = entriesOf(fresh);
        setSelected(list.find((entry) => !answeredOf(entry))?.token ?? list[0]?.token);
        setProblem(null);
      })
      .catch((error: unknown) => {
        if (current) setProblem(messageOf(error));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [reviewer, session.reviewer]);

  const total = entries.length;
  const done = entries.filter(answeredOf).length;
  const entry = entries.find((candidate) => candidate.token === selected);

  const markAnswered = (token: string) => {
    setSession((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.token === token ? { ...item, answered: true } : item,
      ),
      comparisons: current.comparisons.map((comparison) =>
        comparison.token === token ? { ...comparison, answered: true } : comparison,
      ),
    }));
    // Advance to the next unanswered entry after this one, wrapping around.
    const at = entries.findIndex((candidate) => candidate.token === token);
    const after = [...entries.slice(at + 1), ...entries.slice(0, at)];
    const next = after.find((candidate) => !answeredOf(candidate));
    if (next !== undefined) setSelected(next.token);
  };

  const submit = (token: string, answer: ReviewAnswer['answer']) => {
    if (reviewer === null) return;
    setSave({ type: 'saving' });
    reviewApi
      .answer({ token, reviewer, answer })
      .then(() => {
        setSave(IDLE);
        markAnswered(token);
      })
      .catch((error: unknown) => {
        setSave({ type: 'failed', message: messageOf(error) });
      });
  };

  const finish = () => {
    setFinishing(true);
    setProblem(null);
    reviewApi
      .finish()
      .then((results) => {
        window.location.hash = AGREEMENT_HASH;
        props.onFinished(results);
      })
      .catch((error: unknown) => {
        setFinishing(false);
        setProblem(messageOf(error));
      });
  };

  const header = (
    <div className="review-bar">
      {reviewer !== null && (
        <>
          <p className="review-who">
            Reviewing as <strong>{reviewer}</strong>{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setReviewer(null);
              }}
            >
              Change name
            </button>
          </p>
          <p className="review-progress" aria-live="polite">
            <span className="progress-text">
              {done} of {total} reviewed
            </span>
            <span className="progress-rule" aria-hidden="true">
              <span style={{ width: total === 0 ? '0%' : `${String((done / total) * 100)}%` }} />
            </span>
          </p>
          <button
            type="button"
            className="button"
            disabled={finishing}
            onClick={() => {
              if (done < total && !confirming) setConfirming(true);
              else finish();
            }}
          >
            {finishing ? 'Finishing…' : 'Finish pass'}
          </button>
        </>
      )}
    </div>
  );

  return (
    <Frame meta={<span>Review of {session.experimentId}</span>} nav={header}>
      {problem !== null && (
        <p className="review-problem" role="alert">
          {problem}
        </p>
      )}
      {confirming && !finishing && (
        <section className="confirm" role="alertdialog" aria-labelledby="confirm-heading">
          <h2 id="confirm-heading">Finish with {total - done} not reviewed?</h2>
          <p>
            Finishing shows which arm each run belongs to and ends the pass: no more answers are
            accepted.
          </p>
          <div className="confirm-actions">
            <button type="button" className="button button-primary" onClick={finish}>
              Finish pass
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep reviewing
            </button>
          </div>
        </section>
      )}
      {reviewer === null ? (
        <NameForm
          onName={(name) => {
            storeReviewer(name);
            setReviewer(name);
          }}
        />
      ) : total === 0 ? (
        <section className="message">
          <h1>Nothing to review</h1>
          <p>
            No task of this experiment has checklist or review questions or a comparison grader. Add
            them to the suite and run it again to review its runs.
          </p>
        </section>
      ) : (
        <div className="review-layout" aria-busy={loading}>
          <nav className="queue" aria-label="Review queue">
            <ol>
              {entries.map((candidate) => (
                <li key={candidate.token}>
                  <button
                    type="button"
                    className={answeredOf(candidate) ? 'queue-entry answered' : 'queue-entry'}
                    aria-current={candidate.token === selected ? 'true' : undefined}
                    onClick={() => {
                      setSave(IDLE);
                      setSelected(candidate.token);
                    }}
                  >
                    <span className="queue-task">{taskOf(candidate)}</span>
                    <span className="queue-label">{candidate.label}</span>
                    <span className="queue-state">
                      {answeredOf(candidate) ? 'reviewed' : 'to review'}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <div className="review-main">
            {entry?.kind === 'item' && (
              <ItemView
                key={entry.token}
                item={entry.item}
                label={entry.label}
                state={save}
                onSave={(answers: ChecklistAnswer[]) => {
                  submit(entry.token, { type: 'checklist', answers });
                }}
              />
            )}
            {entry?.kind === 'comparison' && (
              <ComparisonView
                key={entry.token}
                comparison={entry.comparison}
                label={entry.label}
                state={save}
                onSave={(preferred, reason) => {
                  submit(entry.token, {
                    type: 'comparison',
                    preferred,
                    ...(reason === undefined ? {} : { reason }),
                  });
                }}
              />
            )}
          </div>
        </div>
      )}
    </Frame>
  );
}

function taskOf(entry: Entry): string {
  return entry.kind === 'item' ? entry.item.taskId : entry.comparison.taskId;
}

function NameForm({ onName }: { readonly onName: (name: string) => void }) {
  const [name, setName] = useState('');
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed !== '') onName(trimmed);
  };
  return (
    <section className="message">
      <h1>Who is reviewing?</h1>
      <p>
        Your name is stored with each answer, so several people can review the same runs. Which arm
        a run belongs to stays hidden until you finish the pass.
      </p>
      <form className="name-form" onSubmit={onSubmit}>
        <label className="field">
          <span>Your name</span>
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </label>
        <button type="submit" className="button button-primary" disabled={name.trim() === ''}>
          Start reviewing
        </button>
      </form>
    </section>
  );
}
