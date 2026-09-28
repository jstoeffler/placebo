# @placebo-eval/report

The single-file HTML report. `pnpm --filter @placebo-eval/report build` writes `dist/report.html`: one file, every script and style inlined, no external references. The cli ships it and embeds the results.

## Embedding contract (for the cli)

The built `dist/report.html` contains exactly one placeholder:

```html
<script id="placebo-results" type="application/json"><!--PLACEBO_RESULTS--></script>
```

To write a report:

1. Validate the data with the `Results` schema from `@placebo-eval/core/results`.
2. Serialize it with `JSON.stringify(results)`, then replace **every** `<` with the six characters `<`. This is a valid JSON escape, so `JSON.parse` returns the same data, and the text can never close the tag (`</script>`) or open a comment (`<!--`).
3. Replace the first occurrence of `<!--PLACEBO_RESULTS-->` with that string. Use a replacer function (`html.replace(PLACEHOLDER, () => json)`) so `$&`, `$1` and similar sequences in the data are not read as replacement patterns.

`src/data/embed.ts` (`serializeForEmbedding`, `embedResults`) is the reference implementation; the cli cannot import report code, so it copies these few lines.

Review mode: `placebo review` puts `data-mode="review"` on the same tag and embeds a `ReviewSession` (validated with the schema of the same name) instead of results: the blinded queue of runs and comparisons, in which no arm, variant name, run id or verdict appears. The app then shows the review queue and talks to the review server's `/api/*` routes; finishing the pass swaps in the full results. Results embedded with `data-mode="review"` are shown with arm labels hidden. `placebo run` and `placebo report` leave the attribute off.

What the reader sees:

| Tag content | Report shows |
|---|---|
| placeholder, empty, or no tag | how to generate a report (`placebo run`, `placebo report`) |
| not JSON, or no `schemaVersion` | an error naming the problem |
| `schemaVersion` other than `RESULTS_SCHEMA_VERSION` | the version found and the version it reads |
| fails the `Results` schema | the first issue path, e.g. `runs[3].grades[0].score`, and its message |
| valid | the report |
| review mode, a `ReviewSession` | the review queue, or the first issue path when it fails the schema |

## Number formatting

Differences, ranges, verdicts, runs needed, per-run means, currency, token counts, durations and byte sizes come from `@placebo-eval/core/format`, the same functions the terminal card and table use, so both print the same strings. `src/format.ts` holds only what the report alone shows: timestamps.

## Scripts

- `dev`: Vite dev server with `fixtures/rich.json` embedded (`PLACEBO_FIXTURE=minimal` to switch).
- `dev:review`: the same with `fixtures/review.json` in review mode, and a stand-in for the review server's API that accepts answers without keeping them and finishes with `fixtures/rich.json`.
- `fixtures`: regenerates `fixtures/*.json` from a fixed seed; the output is committed.
- `preview [rich|minimal]`: embeds a fixture into the built `dist/report.html` and writes `.preview/<name>.html`.
