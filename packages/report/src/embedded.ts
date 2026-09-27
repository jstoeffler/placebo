import type { Results } from '@placebo-eval/core/results';

/** Id of the `<script type="application/json">` tag the cli embeds results in. */
export const RESULTS_ELEMENT_ID = 'placebo-results';

export type Embedded =
  | { readonly state: 'absent' }
  | { readonly state: 'invalid'; readonly reason: string }
  | { readonly state: 'loaded'; readonly results: Results };

/**
 * Reads the embedded results from the text of the results tag (null when there is no tag).
 * The cli validated the data against the `Results` schema before embedding it; here we only
 * check what the shell needs so a hand-edited file fails loudly instead of rendering nonsense.
 */
export function readEmbedded(text: string | null): Embedded {
  if (text === null || text.trim() === '') return { state: 'absent' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { state: 'invalid', reason: 'embedded results are not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || !('schemaVersion' in data)) {
    return { state: 'invalid', reason: 'embedded results have no schemaVersion' };
  }
  if (data.schemaVersion !== 1) {
    return {
      state: 'invalid',
      reason: `unsupported schemaVersion ${JSON.stringify(data.schemaVersion)}`,
    };
  }
  return { state: 'loaded', results: data as Results };
}
