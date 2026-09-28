import type { ChecklistAnswer, ReviewItem } from '@placebo-eval/core/results';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { ChangeView } from '../views/ChangeView.js';
import { Timeline } from '../views/Timeline.js';
import { Checks } from './Checks.js';
import { SaveBar } from './SaveBar.js';
import { isTyping, type SaveState } from './shared.js';

/**
 * One run to review: its change, checks and transcript, with the checklist to answer. Keys: `y`
 * and `n` answer the focused question (the first unanswered one when none has focus) and move
 * on; Enter saves once every question has an answer.
 */
export function ItemView(props: {
  readonly item: ReviewItem;
  readonly label: string;
  readonly state: SaveState;
  readonly onSave: (answers: ChecklistAnswer[]) => void;
}) {
  const { item } = props;
  const [yes, setYes] = useState<(boolean | undefined)[]>(() =>
    item.questions.map(() => undefined),
  );
  const [notes, setNotes] = useState<string[]>(() => item.questions.map(() => ''));
  const groups = useRef<(HTMLFieldSetElement | null)[]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const complete = yes.every((answer) => answer !== undefined);
  const locked = item.answered || props.state.type === 'saving';

  useEffect(() => {
    heading.current?.focus();
  }, [item.token]);

  const answer = (index: number, value: boolean) => {
    setYes((current) => current.map((old, i) => (i === index ? value : old)));
  };

  const save = () => {
    if (!complete || locked) return;
    props.onSave(
      item.questions.map((question, i) => {
        const note = notes[i]?.trim() ?? '';
        return { question, yes: yes[i] === true, ...(note === '' ? {} : { note }) };
      }),
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (locked || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target))
        return;
      if (event.key === 'Enter') {
        if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement)
          return;
        event.preventDefault();
        save();
        return;
      }
      const key = event.key.toLowerCase();
      if (key !== 'y' && key !== 'n') return;
      const focused = groups.current.findIndex(
        (group) => group?.contains(document.activeElement) === true,
      );
      const index = focused === -1 ? yes.findIndex((value) => value === undefined) : focused;
      if (index === -1) return;
      event.preventDefault();
      answer(index, key === 'y');
      const next = groups.current[index + 1];
      next?.querySelector('input')?.focus();
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
          {item.taskId} <span className="run-sub">{props.label}</span>
        </h2>
        <blockquote className="prompt">{item.prompt}</blockquote>
      </header>

      <section className="change-and-grades" aria-label="Change and checklist">
        <div className="change-column">
          <h3>Change</h3>
          <ChangeView change={item.change} />
        </div>
        <div className="grades-column">
          <form className="checklist" onSubmit={onSubmit} aria-labelledby="checklist-heading">
            <h3 id="checklist-heading">Checklist</h3>
            {item.answered && <p className="review-done">You have reviewed this run.</p>}
            <ol className="questions">
              {item.questions.map((question, i) => (
                <li key={question}>
                  <fieldset
                    className="question"
                    ref={(element) => {
                      groups.current[i] = element;
                    }}
                    disabled={locked}
                  >
                    <legend>{question}</legend>
                    <div className="toggle">
                      {([true, false] as const).map((value) => (
                        <label key={String(value)} className="toggle-option">
                          <input
                            type="radio"
                            name={`${item.token}-${String(i)}`}
                            checked={yes[i] === value}
                            onChange={() => {
                              answer(i, value);
                            }}
                          />
                          <span>{value ? 'Yes' : 'No'}</span>
                        </label>
                      ))}
                    </div>
                    <input
                      type="text"
                      className="note-input"
                      aria-label={`Note on "${question}" (optional)`}
                      placeholder="Note (optional)"
                      value={notes[i] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setNotes((current) => current.map((old, j) => (j === i ? value : old)));
                      }}
                    />
                  </fieldset>
                </li>
              ))}
            </ol>
            <SaveBar
              state={props.state}
              ready={complete && !item.answered}
              hint={
                complete
                  ? 'Enter saves.'
                  : `${String(yes.filter((value) => value === undefined).length)} to answer. y or n answers the focused question.`
              }
            />
          </form>
          <h3 className="checks-heading">Checks</h3>
          <Checks checks={item.checks} />
        </div>
      </section>

      {item.events !== undefined && (
        <section aria-labelledby="timeline-heading">
          <h3 id="timeline-heading">Timeline</h3>
          <Timeline events={item.events} />
        </section>
      )}
    </article>
  );
}
