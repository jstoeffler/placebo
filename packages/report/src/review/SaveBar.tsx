import type { SaveState } from './shared.js';

/** The Save button of an answer, with a hint while it cannot save and the reason it failed. */
export function SaveBar(props: {
  readonly state: SaveState;
  readonly ready: boolean;
  readonly hint: string;
}) {
  const saving = props.state.type === 'saving';
  return (
    <div className="save-bar">
      <button type="submit" className="button button-primary" disabled={!props.ready || saving}>
        {saving ? 'Saving…' : 'Save and next'}
      </button>
      {props.state.type === 'failed' ? (
        <p className="save-error" role="alert">
          {props.state.message}
        </p>
      ) : (
        <p className="save-hint">{props.hint}</p>
      )}
    </div>
  );
}
