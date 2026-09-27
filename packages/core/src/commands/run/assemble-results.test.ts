import { describe, expect, it } from 'vitest';
import { GraderSpec, Task } from '../../domain/suite.js';
import { createSeededRandom } from '../../kernel/random.js';
import type { RunId } from '../../kernel/ids.js';
import { commandGrade, makeExperiment, makeReview, makeRun } from '../../testing/fixtures.js';
import { assembleResults, graderLabel } from './assemble-results.js';

const MARGINS = { passRate: 5, cost: 10, tokens: 10, duration: 15 };
const clock = { now: () => new Date('2026-09-27T12:00:00.000Z') };

describe('assembleResults', () => {
  const experiment = makeExperiment({ runsPerTask: 1 });
  const runs = [
    makeRun({ id: 'c1', arm: 'control', grades: [commandGrade(true)] }),
    makeRun({ id: 't1', arm: 'none', grades: [commandGrade(false)] }),
    makeRun({ id: 'other', experimentId: 'exp-2', arm: 'none' }),
  ];
  const task = Task.parse({
    id: 'refund-rounding',
    prompt: 'Fix the rounding.',
    graders: [{ type: 'command', run: 'pnpm test' }, { type: 'comparison' }],
  });
  const input = {
    experiment,
    runs,
    reviews: [makeReview({ runId: 'c1' }), makeReview({ id: 'rev-2', runId: 'other' })],
    suite: { tasks: [task, Task.parse({ ...task, id: 'unused' })] },
    margins: MARGINS,
    random: createSeededRandom(experiment.seed),
    clock,
    warnings: [{ type: 'judge_equals_subject' as const, model: 'x' }],
    resamples: 20,
  };

  it('fills every field of Results for the experiment only', () => {
    const results = assembleResults(input);
    expect(results.schemaVersion).toBe(1);
    expect(results.generatedAt).toBe('2026-09-27T12:00:00.000Z');
    expect(results.experiment).toEqual(experiment);
    expect(results.arms).toEqual(experiment.arms);
    expect(results.margins).toEqual(MARGINS);
    expect(results.runs.map((run) => run.id)).toEqual(['c1', 't1']);
    expect(results.reviews.map((review) => review.runId)).toEqual(['c1' as RunId]);
    expect(results.tasks).toEqual([
      {
        id: 'refund-rounding',
        prompt: 'Fix the rounding.',
        graders: [
          { index: 0, type: 'command', label: 'command: pnpm test' },
          { index: 1, type: 'comparison', label: 'comparison' },
        ],
      },
    ]);
    expect(results.verdictCards.map((card) => card.variant)).toEqual(['none']);
    expect(results.warnings).toEqual([
      { type: 'few_tasks', taskCount: 1, threshold: 5 },
      { type: 'judge_equals_subject', model: 'x' },
    ]);
  });

  it('replays from the seed', () => {
    const again = assembleResults({ ...input, random: createSeededRandom(experiment.seed) });
    expect(again).toEqual(
      assembleResults({ ...input, random: createSeededRandom(experiment.seed) }),
    );
  });

  it('works without warnings, resamples or a known task', () => {
    const results = assembleResults({
      experiment,
      runs,
      reviews: [],
      suite: { tasks: [] },
      margins: MARGINS,
      random: createSeededRandom(experiment.seed),
      clock,
    });
    expect(results.tasks).toEqual([]);
    expect(results.warnings).toEqual([{ type: 'few_tasks', taskCount: 1, threshold: 5 }]);
  });
});

describe('graderLabel', () => {
  it.each([
    [{ type: 'command', run: 'pnpm test' }, 'command: pnpm test'],
    [{ type: 'file_exists', path: 'a.ts' }, 'file_exists: a.ts'],
    [{ type: 'file_modified', path: 'b.ts' }, 'file_modified: b.ts'],
    [{ type: 'regex', pattern: 'round\\(' }, 'regex: /round\\(/ on the change'],
    [{ type: 'regex', pattern: 'x', on: 'transcript' }, 'regex: /x/ on the transcript'],
    [{ type: 'tool_used', tool: 'Grep' }, 'tool_used: Grep'],
    [{ type: 'checklist', questions: 'q.md' }, 'checklist: q.md'],
    [{ type: 'checklist', questions: 'q.md', agentic: true }, 'checklist: q.md (agentic)'],
    [{ type: 'comparison' }, 'comparison'],
  ])('labels %j', (spec, label) => {
    expect(graderLabel(GraderSpec.parse(spec))).toBe(label);
  });
});
