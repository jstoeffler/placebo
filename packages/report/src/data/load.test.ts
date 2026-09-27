import { Results } from '@placebo-eval/core/results';
import { describe, expect, it } from 'vitest';
import { fixture, fixtureText } from '../testing/fixtures.js';
import { embedResults, RESULTS_PLACEHOLDER, serializeForEmbedding } from './embed.js';
import { formatPath, loadResults, readMode } from './load.js';

describe('fixtures', () => {
  it.each(['rich', 'minimal'] as const)('%s matches the Results schema', (name) => {
    expect(Results.safeParse(fixture(name)).success).toBe(true);
  });

  it('rich covers what the report must show', () => {
    const results = fixture('rich');
    expect(results.verdictCards).toHaveLength(2);
    expect(results.experiment.taskIds).toHaveLength(5);
    expect(results.experiment.runsPerTask).toBe(5);
    const verdicts = new Set(
      results.verdictCards.flatMap((card) => card.rows.map((r) => r.verdict)),
    );
    expect([...verdicts].sort()).toEqual(['harms', 'helps', 'no_evidence', 'placebo']);
    expect(results.deadTasks).toEqual(['migrate-date-utils']);
    expect(results.warnings.length).toBeGreaterThan(0);
    expect(results.reviews.length).toBeGreaterThan(0);
    const details = results.runs.flatMap((run) => run.grades.map((grade) => grade.detail));
    expect(details.some((d) => d.type === 'judge' && d.answers !== undefined)).toBe(true);
    expect(details.some((d) => d.type === 'judge' && d.opponentRunId !== undefined)).toBe(true);
    expect(details.some((d) => d.type === 'review')).toBe(true);
  });

  it('minimal has one treatment, one task and one run per arm', () => {
    const results = fixture('minimal');
    expect(results.verdictCards).toHaveLength(1);
    expect(results.experiment.taskIds).toHaveLength(1);
    expect(results.runs).toHaveLength(2);
  });
});

describe('loadResults', () => {
  it('is absent without a tag, with an empty tag, or with the placeholder', () => {
    expect(loadResults(null)).toEqual({ state: 'absent' });
    expect(loadResults('  \n')).toEqual({ state: 'absent' });
    expect(loadResults(RESULTS_PLACEHOLDER)).toEqual({ state: 'absent' });
  });

  it('loads and validates results, in report mode by default', () => {
    const loaded = loadResults(fixtureText('minimal'));
    expect(loaded.state).toBe('loaded');
    if (loaded.state === 'loaded') expect(loaded.mode).toBe('report');
    const review = loadResults(fixtureText('minimal'), 'review');
    expect(review.state === 'loaded' && review.mode).toBe('review');
  });

  it.each([
    ['{', 'the embedded results are not valid JSON'],
    ['[]', 'the embedded results have no schemaVersion'],
    ['null', 'the embedded results have no schemaVersion'],
  ])('rejects %j', (text, reason) => {
    expect(loadResults(text)).toEqual({ state: 'invalid', reason });
  });

  it('refuses versions it does not know', () => {
    expect(loadResults('{"schemaVersion":2}')).toEqual({ state: 'unsupported', version: 2 });
  });

  it('names the path of the first schema issue', () => {
    const data = fixture('minimal');
    const broken = { ...data, runs: [{ ...data.runs[0], outcome: 'exploded' }] };
    const loaded = loadResults(JSON.stringify(broken));
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'invalid') {
      expect(loaded.path).toBe('runs[0].outcome');
      expect(loaded.reason).toMatch(/expected one of/i);
    }
  });

  it('formats issue paths', () => {
    expect(formatPath([])).toBe('(root)');
    expect(formatPath(['runs', 3, 'grades', 0, 'score'])).toBe('runs[3].grades[0].score');
  });

  it('reads the mode', () => {
    expect(readMode('review')).toBe('review');
    expect(readMode(undefined)).toBe('report');
    expect(readMode('other')).toBe('report');
  });
});

describe('embedding', () => {
  const tricky = { text: '</script><!-- $& $1 <b>', n: 1 };

  it('never lets data close the tag or open a comment', () => {
    const json = serializeForEmbedding(tricky);
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual(tricky);
  });

  it('replaces the placeholder literally, even with $ patterns in the data', () => {
    const html = `<script id="placebo-results" type="application/json">${RESULTS_PLACEHOLDER}</script>`;
    const embedded = embedResults(html, tricky);
    const inner = /<script[^>]*>([\s\S]*)<\/script>/.exec(embedded)?.[1] ?? '';
    expect(JSON.parse(inner)).toEqual(tricky);
    expect(() => embedResults('<html></html>', tricky)).toThrow(/placeholder/);
  });
});
