import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Results } from '@placebo-eval/core/results';
import { UsageError } from './errors.js';

/** The comment the built `report.html` carries until results replace it (report README). */
export const RESULTS_PLACEHOLDER = '<!--PLACEBO_RESULTS-->';

/**
 * Results as text for the inside of `<script type="application/json">`: every `<` becomes the
 * JSON escape `<`, so the text can never close the tag or open a comment, and `JSON.parse`
 * still returns the same data.
 */
export function serializeForEmbedding(results: Results): string {
  return JSON.stringify(results).replaceAll('<', '\\u003c');
}

/** The built report with `results` in place of the placeholder. */
export function embedResults(html: string, results: Results): string {
  if (!html.includes(RESULTS_PLACEHOLDER)) {
    throw new Error(`the report template has no ${RESULTS_PLACEHOLDER} placeholder`);
  }
  const json = serializeForEmbedding(results);
  // A replacer function, so `$&` and similar sequences in the data stay literal.
  return html.replace(RESULTS_PLACEHOLDER, () => json);
}

/**
 * The built report template: next to the bundled cli (`dist/report.html`), or when running from
 * source, the cli's or the report package's build output.
 */
export function locateReportTemplate(): string {
  const candidates = ['report.html', '../dist/report.html', '../../report/dist/report.html'].map(
    (relative) => fileURLToPath(new URL(relative, import.meta.url)),
  );
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    throw new UsageError(
      `the report template report.html is not built (looked in ${candidates.join(', ')}); run pnpm build`,
    );
  }
  return found;
}

export interface Artifacts {
  readonly report: string;
  readonly results: string;
}

/** Validates `results`, then writes `results.json` and `report.html` into `outDir`. */
export async function writeArtifacts(
  outDir: string,
  results: Results,
  templatePath: string,
): Promise<Artifacts> {
  const valid = Results.parse(results);
  const template = await readFile(templatePath, 'utf8');
  await mkdir(outDir, { recursive: true });
  const paths = { report: join(outDir, 'report.html'), results: join(outDir, 'results.json') };
  await writeFile(paths.results, `${JSON.stringify(valid, null, 2)}\n`);
  await writeFile(paths.report, embedResults(template, valid));
  return paths;
}
