import type { ReviewComparison, ReviewSide } from '@placebo-eval/core/results';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { ChangeView } from '../views/ChangeView.js';
import { Checks } from './Checks.js';
import { SaveBar } from './SaveBar.js';
import { isTyping, type SaveState } from './shared.js';

/**
 * Two results of one task side by side as `a` and `b`, arms hidden, and the choice of the better
 * one with an optional reason. Keys: `a` or `b` chooses, Enter saves.
 */
export function ComparisonView(props: {
  readonly comparison: ReviewComparison;
  readonly label: string;
  readonly state: SaveState;
  readonly onSave: (preferred: 'a' | 'b', reason: string | undefined) => void;
}) {
  const { comparison } = props;
  const [preferred, setPreferred] = useState<'a' | 'b' | undefined>(undefined);
  const [reason, setReason] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const locked = comparison.answered || props.state.type === 'saving';

  useEffect(() => {
    heading.current?.focus();
  }, [comparison.token]);

  const save = () => {
    if (preferred === undefined || locked) return;
    const trimmed = reason.trim();
    props.onSave(preferred, trimmed === '' ? undefined : trimmed);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target))
        return;
      if (event.key === 'a' || event.key === 'b') {
        event.preventDefault();
        setPreferred(event.key);
      } else if (
        event.key === 'Enter' &&
        !(event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
      ) {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  });

  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    save();
  };

  return (
    <article className="review-entry-view" aria-labelledby="review-heading">
      <header className="run-head">
        <h2 id="review-heading" ref={heading} tabIndex={-1}>
          {comparison.taskId} <span className="run-sub">{props.label}</span>
        </h2>
        <blockquote className="prompt">{comparison.prompt}</blockquote>
      </header>

      <form className="choice" onSubmit={onSubmit}>
        {comparison.answered && <p className="review-done">You have compared these two.</p>}
        <fieldset className="choice-options" disabled={locked}>
          <legend>Which result is better?</legend>
          <div className="toggle">
            {(['a', 'b'] as const).map((side) => (
              <label key={side} className="toggle-option">
                <input
                  type="radio"
                  name={`${comparison.token}-preferred`}
                  checked={preferred === side}
                  onChange={() => {
                    setPreferred(side);
                  }}
                />
                <span>{side} is better</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="reason">
          <span>Why (optional)</span>
          <textarea
            rows={2}
            value={reason}
            disabled={locked}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        </label>
        <SaveBar
          state={props.state}
          ready={preferred !== undefined && !comparison.answered}
          hint={preferred === undefined ? 'Press a or b to choose.' : 'Enter saves.'}
        />
      </form>

      <div className="sides">
        <Side name="a" side={comparison.a} chosen={preferred === 'a'} />
        <Side name="b" side={comparison.b} chosen={preferred === 'b'} />
      </div>
    </article>
  );
}

function Side(props: {
  readonly name: 'a' | 'b';
  readonly side: ReviewSide;
  readonly chosen: boolean;
}) {
  return (
    <section
      className={props.chosen ? 'side side-chosen' : 'side'}
      aria-labelledby={`side-${props.name}`}
    >
      <h3 id={`side-${props.name}`} className="side-name">
        Result {props.name}
      </h3>
      <ChangeView change={props.side.change} />
      <h4 className="checks-heading">Checks</h4>
      <Checks checks={props.side.checks} />
    </section>
  );
}
