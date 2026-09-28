import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Results, type ReviewSession } from '@placebo-eval/core/results';
import { sampleResults } from '@placebo-eval/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  embedResults,
  embedReviewSession,
  locateReportTemplate,
  RESULTS_PLACEHOLDER,
  serializeForEmbedding,
  writeArtifacts,
} from './report-files.js';

const TEMPLATE = `<html><script id="placebo-results" type="application/json">${RESULTS_PLACEHOLDER}</script></html>`;

/** Results whose text holds everything that could break out of the tag or the replacement. */
const tricky = Results.parse({
  ...sampleResults,
  tasks: [
    {
      id: 'refund-rounding',
      prompt: 'Close </script><!-- and keep $& $1 $$ $` intact',
      graders: [{ index: 0, type: 'command', label: 'command: pnpm vitest run' }],
    },
  ],
});

function embedded(html: string): string {
  const match = /<script id="placebo-results" type="application\/json">(.*)<\/script>/s.exec(html);
  if (match?.[1] === undefined) throw new Error('no results tag');
  return match[1];
}

describe('embedding results in the report', () => {
  it('escapes every < so the data cannot close the tag or open a comment', () => {
    const text = serializeForEmbedding(tricky);
    expect(text).not.toContain('<');
    expect(text).toContain('\\u003c/script>\\u003c!--');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(tricky)));
  });

  it('keeps $& and other replacement patterns literal', () => {
    const html = embedResults(TEMPLATE, tricky);
    expect(html).not.toContain(RESULTS_PLACEHOLDER);
    const data = JSON.parse(embedded(html)) as Results;
    expect(data.tasks[0]?.prompt).toBe('Close </script><!-- and keep $& $1 $$ $` intact');
  });

  it('refuses a template without the placeholder', () => {
    expect(() => embedResults('<html></html>', tricky)).toThrow(/no <!--PLACEBO_RESULTS-->/);
  });
});

describe('embedding a review session', () => {
  const session = {
    experimentId: 'exp-1',
    reviewer: null,
    taskCount: 1,
    items: [],
    comparisons: [],
  } as unknown as ReviewSession;

  it('marks the tag as review mode and embeds the session', () => {
    const html = embedReviewSession(TEMPLATE, session);
    expect(html).toBe(
      `<html><script data-mode="review" id="placebo-results" type="application/json">${serializeForEmbedding(session)}</script></html>`,
    );
  });

  it('refuses a template without the placeholder in a script tag', () => {
    expect(() => embedReviewSession('<html></html>', session)).toThrow(/placeholder/);
    expect(() => embedReviewSession(`<p>${RESULTS_PLACEHOLDER}</p>`, session)).toThrow(
      /placeholder/,
    );
  });
});

describe('writeArtifacts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'placebo-artifacts-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes pretty results.json and report.html into a new folder', async () => {
    const template = join(dir, 'template.html');
    await writeFile(template, TEMPLATE);
    const paths = await writeArtifacts(join(dir, 'out', 'exp'), tricky, template);
    expect(paths).toEqual({
      report: join(dir, 'out', 'exp', 'report.html'),
      results: join(dir, 'out', 'exp', 'results.json'),
    });
    const json = await readFile(paths.results, 'utf8');
    expect(json).toBe(`${JSON.stringify(tricky, null, 2)}\n`);
    expect(JSON.parse(embedded(await readFile(paths.report, 'utf8')))).toEqual(JSON.parse(json));
  });

  it('refuses results that fail the schema', async () => {
    await expect(
      writeArtifacts(dir, { ...tricky, schemaVersion: 2 } as never, join(dir, 'missing.html')),
    ).rejects.toThrow(/schemaVersion/);
  });
});

describe('locateReportTemplate', () => {
  it('finds a built report next to the cli or in the report package', () => {
    // The workspace builds the report before cli tests run in CI only after `pnpm build`; when
    // neither exists the error says what to do.
    try {
      expect(locateReportTemplate()).toMatch(/report\.html$/);
    } catch (error) {
      expect(String(error)).toMatch(/run pnpm build/);
    }
  });
});
