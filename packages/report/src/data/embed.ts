// No imports: vite.config.ts and the preview script load this module directly in Node.

/** The comment the built `report.html` carries inside the results tag until the cli replaces it. */
export const RESULTS_PLACEHOLDER = '<!--PLACEBO_RESULTS-->';

/**
 * Serializes results for the inside of `<script type="application/json">`. Every `<` becomes
 * the JSON escape `<`, which is the same string to `JSON.parse` but can never close the tag (`</script>`)
 * or open a comment (`<!--`). The cli implements the same contract; see README.md.
 */
export function serializeForEmbedding(results: unknown): string {
  return JSON.stringify(results).replaceAll('<', '\\u003c');
}

/** Puts serialized results into a built `report.html` in place of the placeholder comment. */
export function embedResults(html: string, results: unknown): string {
  if (!html.includes(RESULTS_PLACEHOLDER)) {
    throw new Error(`report.html has no ${RESULTS_PLACEHOLDER} placeholder`);
  }
  const json = serializeForEmbedding(results);
  // A replacer function, so `$` sequences in the data are never read as replacement patterns.
  return html.replace(RESULTS_PLACEHOLDER, () => json);
}
