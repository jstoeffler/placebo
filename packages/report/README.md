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

Optional: `data-mode="review"` on the same tag switches the app to review mode (arm names hidden, room for a review panel). `placebo review` will set it; `placebo run` and `placebo report` leave it off.

What the reader sees:

| Tag content | Report shows |
|---|---|
| placeholder, empty, or no tag | how to generate a report (`placebo run`, `placebo report`) |
| not JSON, or no `schemaVersion` | an error naming the problem |
| `schemaVersion` other than `RESULTS_SCHEMA_VERSION` | the version found and the version it reads |
| fails the `Results` schema | the first issue path, e.g. `runs[3].grades[0].score`, and its message |
| valid | the report |

## Number formatting

Shared with the terminal card in core; both must print the same strings.

- Differences carry an explicit sign (`+`, `-`; zero has none). `pts` and `percent`: an integer when the absolute value is 10 or more, else one decimal (`-7.0 pts`, `-18 %`). `absolute`: at most two decimals, trailing zeros dropped (`-1.2`, `-0.69`).
- Ranges: both ends signed, no unit: `[-30, +15]`.
- Runs needed: `(≈12 runs/task to decide)`; above 1000, `(more than 1000 runs/task)`.
- Currency `$0.42`; counts `12,345`; durations `12.3 s`, `1 m 04 s`, `2 h 03 m`.

## Scripts

- `dev`: Vite dev server with `fixtures/rich.json` embedded (`PLACEBO_FIXTURE=minimal` to switch).
- `fixtures`: regenerates `fixtures/*.json` from a fixed seed; the output is committed.
- `preview [rich|minimal]`: embeds a fixture into the built `dist/report.html` and writes `.preview/<name>.html`.
