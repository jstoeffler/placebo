import { Results, RESULTS_SCHEMA_VERSION, ReviewSession } from '@placebo-eval/core/results';
import { RESULTS_PLACEHOLDER } from './embed.js';

/** Id of the `<script type="application/json">` tag the cli embeds results in. */
const RESULTS_ELEMENT_ID = 'placebo-results';

/**
 * How the report is used. `report` is the static file written by `placebo run`. `review` is the
 * same file served by `placebo review`: the tag then holds a blinded `ReviewSession` instead of
 * results, and the app shows the review queue. Results in review mode are shown with arm labels
 * hidden. Set with `data-mode` on the results tag.
 */
export type ReportMode = 'report' | 'review';

export type Loaded =
  | { readonly state: 'absent' }
  | { readonly state: 'unsupported'; readonly version: unknown }
  | { readonly state: 'invalid'; readonly reason: string; readonly path?: string }
  | { readonly state: 'loaded'; readonly results: Results; readonly mode: ReportMode }
  | { readonly state: 'review'; readonly session: ReviewSession };

/**
 * The single data-loading boundary of the report: turns the text of the results tag (null when
 * there is no tag) into validated `Results`, or in review mode a validated `ReviewSession`, or
 * into a state the app explains to the reader.
 */
export function loadResults(text: string | null, mode: ReportMode = 'report'): Loaded {
  if (text === null) return { state: 'absent' };
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === RESULTS_PLACEHOLDER) return { state: 'absent' };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { state: 'invalid', reason: 'the embedded results are not valid JSON' };
  }
  if (
    mode === 'review' &&
    typeof data === 'object' &&
    data !== null &&
    !('schemaVersion' in data)
  ) {
    const session = ReviewSession.safeParse(data);
    if (!session.success)
      return invalid(session.error.issues[0], 'the review session does not match the schema');
    return { state: 'review', session: session.data };
  }
  if (typeof data !== 'object' || data === null || !('schemaVersion' in data)) {
    return { state: 'invalid', reason: 'the embedded results have no schemaVersion' };
  }
  if (data.schemaVersion !== RESULTS_SCHEMA_VERSION) {
    return { state: 'unsupported', version: data.schemaVersion };
  }
  const parsed = Results.safeParse(data);
  if (!parsed.success)
    return invalid(parsed.error.issues[0], 'the embedded results do not match the schema');
  return { state: 'loaded', results: parsed.data, mode };
}

function invalid(
  issue: { readonly message: string; readonly path: readonly PropertyKey[] } | undefined,
  fallback: string,
): Loaded {
  return {
    state: 'invalid',
    reason: issue?.message ?? fallback,
    path: issue === undefined ? '' : formatPath(issue.path),
  };
}

/** An issue path as `runs[3].grades[0].score`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let text = '';
  for (const key of path) {
    if (typeof key === 'number') text += `[${String(key)}]`;
    else text += text === '' ? String(key) : `.${String(key)}`;
  }
  return text === '' ? '(root)' : text;
}

/** Reads the mode from `data-mode` on the results tag; anything other than `review` is `report`. */
export function readMode(value: string | null | undefined): ReportMode {
  return value === 'review' ? 'review' : 'report';
}

/** Loads the results embedded in the current document. */
export function loadFromDocument(doc: Document): Loaded {
  const element = doc.getElementById(RESULTS_ELEMENT_ID);
  return loadResults(element?.textContent ?? null, readMode(element?.dataset.mode));
}
