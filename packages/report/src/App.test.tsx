// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatCurrency, formatDuration } from '@placebo-eval/core/format';
import { App } from './App.js';
import { loadResults, type ReportMode } from './data/load.js';
import { runOrdinal } from './data/model.js';
import { fixture, fixtureText } from './testing/fixtures.js';

function renderReport(name: 'rich' | 'minimal', hash = '#/', mode: ReportMode = 'report') {
  window.location.hash = hash;
  return render(<App loaded={loadResults(fixtureText(name), mode)} />);
}

function rowTexts(card: HTMLElement): string[][] {
  return within(card)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => cell.textContent)
        .filter((text) => text !== ''),
    );
}

/**
 * Runs `action` and returns once the route change it causes has rendered: it waits for the
 * `hashchange` event itself rather than polling, so a slow machine cannot time it out.
 */
async function routed(action: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    const changed = new Promise<void>((resolve) => {
      window.addEventListener(
        'hashchange',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    await action();
    await changed;
  });
}

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  cleanup();
});

describe('verdict card', () => {
  it('prints the header line and every metric row with exact strings', () => {
    renderReport('rich');
    const card = screen.getByRole('region', { name: /^none vs control/ });
    expect(within(card).getByRole('heading').textContent).toBe(
      'none vs control · 5 runs × 5 tasks · model claude-sonnet-5-20260801 · claude code 2.1.283',
    );
    expect(rowTexts(card)).toEqual([
      ['pass rate', '-25 pts', '[-60, +10]', 'no evidence', '(≈10 runs/task to decide)'],
      ['cost', '-25 %', '[-32, -21]', 'helps'],
      ['tokens in', '-11 %', '[-25, +7.6]', 'no evidence', '(≈11 runs/task to decide)'],
      ['tokens out', '-7 %', '[-21, +12]', 'no evidence', '(≈27 runs/task to decide)'],
      ['cache read', '-7 %', '[-20, +11]', 'no evidence', '(≈25 runs/task to decide)'],
      ['cache write', '+0.6 %', '[-0.3, +1.5]', 'placebo'],
      ['turns', '-0.9', '[-2.5, +0.7]', 'no evidence', '(≈16 runs/task to decide)'],
      ['duration', '-19 %', '[-26, -9.9]', 'helps'],
      ['checklist', '-0.69', '[-1.35, -0.088]', 'harms'],
      ['win rate', '-15 pts', '[-40, +10]', 'no evidence', '(≈14 runs/task to decide)'],
    ]);
  });

  it('shows one card per treatment with all four verdict words', () => {
    renderReport('rich');
    expect(screen.getAllByRole('region', { name: / vs control/ })).toHaveLength(2);
    for (const word of ['helps', 'harms', 'placebo', 'no evidence'])
      expect(screen.getAllByText(word, { selector: '.verdict-word' }).length).toBeGreaterThan(0);
  });

  it('asks for two runs per task instead of an estimate when every task has one', () => {
    renderReport('minimal');
    const card = screen.getByRole('region', { name: /^none vs control/ });
    const note = '(at least 2 runs/task to compute a range)';
    expect(rowTexts(card)).toEqual([
      ['pass rate', '-', '-', 'no evidence', note],
      ['cost', '-', '-', 'no evidence', note],
    ]);
    expect(card.querySelector('.gauge')).toBeNull();
  });

  it('caps runs needed and names the tasks a row leaves out', () => {
    const data = fixture('rich');
    const [card] = data.verdictCards;
    if (card === undefined) throw new Error('no card');
    const rows = card.rows.map((row) =>
      row.metric === 'passRate'
        ? {
            ...row,
            runsNeeded: undefined,
            excludedTasks: [{ taskId: 'fix-refund-rounding', reason: 'too_few_runs' }],
          }
        : row,
    );
    const changed = { ...data, verdictCards: [{ ...card, rows }] };
    render(<App loaded={loadResults(JSON.stringify(changed))} />);
    const region = screen.getByRole('region', { name: /^none vs control/ });
    expect(rowTexts(region)[0]).toEqual([
      'pass rate',
      '-25 pts',
      '[-60, +10]',
      'no evidence',
      '(more than 1000 runs/task)left out: fix-refund-rounding (fewer than 2 runs)',
    ]);
  });
});

describe('warnings and pins', () => {
  it('says each warning in one sentence above the cards', () => {
    renderReport('rich');
    const warnings = screen.getByRole('region', { name: '4 warnings' });
    expect(
      within(warnings)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Every arm scored zero on migrate-date-utils, so it is flagged as unsolvable or brittle and excluded from verdicts.',
      'The variant patch of tests-first touches files outside the configuration surface: docs/architecture.md and vitest.config.ts.',
      'Project-only settings do not keep out the global Claude Code config file and managed policy settings, which may reach every arm.',
      'Claude Code loads /Users/ada/CLAUDE.md from a directory above the run folders, so it reaches every arm.',
    ]);
    const card = screen.getByRole('region', { name: /^none vs control/ });
    expect(warnings.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says results describe these tasks when there are few, and runs are few', () => {
    renderReport('minimal');
    expect(
      screen.getByText(
        'With 1 task, fewer than 5, these results describe these tasks, not the repo.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        'With 1 run per task, fewer than 3, only large differences can be detected; the ranges show how wide the uncertainty is.',
      ),
    ).toBeDefined();
  });

  it('words every warning type', () => {
    const data = fixture('minimal');
    const warnings = [
      { type: 'few_tasks', taskCount: 3, threshold: 5 },
      { type: 'judge_equals_subject', model: 'claude-sonnet-5' },
      { type: 'patch_outside_surface', variant: 'none', paths: ['src/a.ts'] },
      { type: 'dead_task', taskId: 'validate-webhook-signature' },
      { type: 'isolation_residual', sources: ['claude_ai_connectors'] },
      { type: 'ancestor_configuration', paths: ['/Users/ada/CLAUDE.md', '/Users/ada/.claude'] },
      { type: 'few_runs', runsPerTask: 2, threshold: 3 },
      { type: 'background_work_unmeasured' },
    ];
    render(<App loaded={loadResults(JSON.stringify({ ...data, warnings }))} />);
    const region = screen.getByRole('region', { name: '8 warnings' });
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'With 3 tasks, fewer than 5, these results describe these tasks, not the repo.',
      'The judge model is the subject model (claude-sonnet-5), so the judge may favour its own work; pin a different judge model.',
      'The variant patch of none touches files outside the configuration surface: src/a.ts.',
      'Every arm scored zero on validate-webhook-signature, so it is flagged as unsolvable or brittle and excluded from verdicts.',
      'Project-only settings do not keep out claude.ai connectors, which may reach every arm.',
      'Claude Code loads /Users/ada/CLAUDE.md and /Users/ada/.claude from a directory above the run folders, so it reaches every arm.',
      'With 2 runs per task, fewer than 3, only large differences can be detected; the ranges show how wide the uncertainty is.',
      'The suite lets subject runs work in the background, so work still running when Claude Code exits is not measured and cost after its last result is estimated.',
    ]);
  });

  it('lists every pin', () => {
    renderReport('rich');
    const results = fixture('rich');
    const pins = screen.getByRole('region', { name: 'Pins' });
    for (const value of [
      results.experiment.pins.commit,
      results.experiment.pins.subjectModel,
      results.experiment.pins.judgeModel,
      results.experiment.pins.suiteHash,
      String(results.experiment.seed),
    ])
      expect(within(pins).getByText(value)).toBeDefined();
  });
});

describe('tasks', () => {
  it('shows task by arm with the dead task flagged', () => {
    renderReport('rich', '#/tasks');
    expect(
      screen.getByText(
        'Every arm scored zero on this task: it is flagged as unsolvable or brittle and excluded from verdicts.',
      ),
    ).toBeDefined();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 5 * 3 + 1);
  });
});

describe('runs', () => {
  it('filters by task, arm and outcome through the URL', async () => {
    const user = userEvent.setup();
    renderReport('rich', '#/runs');
    expect(screen.getByText('75 runs')).toBeDefined();
    await routed(() => user.selectOptions(screen.getByLabelText('Task'), 'fix-refund-rounding'));
    expect(screen.getByText('15 of 75 runs')).toBeDefined();
    await routed(() => user.selectOptions(screen.getByLabelText('Arm'), 'tests-first'));
    expect(screen.getByText('5 of 75 runs')).toBeDefined();
    expect(window.location.hash).toBe('#/runs?task=fix-refund-rounding&arm=tests-first');
    await routed(() => user.selectOptions(screen.getByLabelText('Task'), ''));
    await routed(() =>
      user.selectOptions(screen.getByLabelText('Outcome'), 'stopped_by_permission_denial'),
    );
    expect(screen.getByText('1 of 75 runs')).toBeDefined();
  });
});

describe('run detail', () => {
  const results = fixture('rich');
  const run = results.runs.find(
    (candidate) => candidate.taskId === 'fix-refund-rounding' && candidate.arm.kind === 'treatment',
  )!;

  it('shows every tool call in order', () => {
    renderReport('rich', `#/runs/${run.id}`);
    const expected = run.events.flatMap((event) =>
      event.type === 'tool_call' ? [event.name] : [],
    );
    const names = Array.from(document.querySelectorAll('.timeline .tool-name')).map(
      (node) => node.textContent,
    );
    expect(names).toEqual(expected);
    expect(names.length).toBeGreaterThan(5);
  });

  it('shows command grades with exit code and output next to the change', () => {
    renderReport('rich', `#/runs/${run.id}`);
    const detail = run.grades[0]!.detail;
    if (detail.type !== 'command') throw new Error('first grade is a command');
    const grades = screen.getByRole('heading', { name: 'Grades' }).parentElement!;
    expect(within(grades).getByText('Exit code')).toBeDefined();
    const outputs = Array.from(grades.querySelectorAll('.output pre')).map(
      (pre) => pre.textContent,
    );
    expect(outputs).toContain(detail.stdout);
    expect(screen.getByRole('heading', { name: 'Change' })).toBeDefined();
    expect(document.querySelector('.diff-path')?.textContent).toBe('src/billing/refund.ts');
  });

  it('shows the judge reasoning and spend, and the reviews', () => {
    const reviewed = results.runs.find((candidate) =>
      candidate.grades.some((grade) => grade.kind === 'review'),
    )!;
    renderReport('rich', `#/runs/${reviewed.id}`);
    expect(screen.getByText(/^Reviewed by /)).toBeDefined();
    expect(screen.getAllByText(/^Judged by claude-opus/).length).toBeGreaterThan(0);
    const judge = reviewed.grades.find((grade) => grade.detail.type === 'judge')!;
    if (judge.detail.type !== 'judge') throw new Error('expected a judge grade');
    expect(screen.getByText(judge.detail.reasoning)).toBeDefined();
    const card = screen.getByText(judge.detail.reasoning).closest('article')!;
    expect(within(card).getByText('Judge cost').nextSibling?.textContent).toBe(
      formatCurrency(judge.detail.spend.costUsd),
    );
    expect(within(card).getByText('Judge calls').nextSibling?.textContent).toBe('1');
  });

  it('shows a comparison with its opponent, position, preference, reason and spend', () => {
    const compared = results.runs.find((candidate) =>
      candidate.grades.some((grade) => grade.detail.type === 'comparison'),
    )!;
    const detail = compared.grades.find((grade) => grade.detail.type === 'comparison')!.detail;
    if (detail.type !== 'comparison') throw new Error('expected a comparison grade');
    const opponent = results.runs.find((candidate) => candidate.id === detail.opponentRunId)!;
    const ordinal = runOrdinal(opponent, results.runs);
    renderReport('rich', `#/runs/${compared.id}`);
    const card = screen.getByText(detail.reason).closest('article')!;
    const other = detail.position === 'a' ? 'b' : 'a';
    expect(card.querySelector('.opponent')?.textContent).toBe(
      `Compared with run ${String(ordinal)} of control; this run was shown as ${detail.position}, the other as ${other}.`,
    );
    expect(card.querySelector('.opponent a')?.getAttribute('href')).toBe(
      `#/runs/${detail.opponentRunId}`,
    );
    expect(
      within(card).getByText(
        detail.preferred ? 'The judge preferred this run.' : 'The judge preferred the other run.',
      ),
    ).toBeDefined();
    expect(card.querySelector('.grade-score')?.textContent).toBe(detail.preferred ? 'won' : 'lost');
    expect(within(card).getByText('Judge cost').nextSibling?.textContent).toBe(
      formatCurrency(detail.spend.costUsd),
    );
  });

  it('shows the message and the spend of a grader that could not score', () => {
    const failed = results.runs.find((candidate) =>
      candidate.grades.some((grade) => grade.detail.type === 'error'),
    )!;
    renderReport('rich', `#/runs/${failed.id}`);
    const message = screen.getByText(
      'The judge answer failed its schema: answers has 2 items, the checklist has 3.',
    );
    const article = message.closest('article');
    expect(article?.querySelector('.grade-score')?.textContent).toBe('error');
    const detail = failed.grades.find((grade) => grade.detail.type === 'error')?.detail;
    const spend = detail?.type === 'error' ? detail.spend : undefined;
    if (spend === undefined || !(article instanceof HTMLElement)) {
      throw new Error('expected an error grade with spend');
    }
    const facts = within(article);
    expect(facts.getByText('Judge cost').nextElementSibling?.textContent).toBe(
      formatCurrency(spend.costUsd),
    );
    expect(facts.getByText('Judge calls').nextElementSibling?.textContent).toBe('1');
  });

  it('steps to the next and previous run within the filter', async () => {
    const user = userEvent.setup();
    const siblings = results.runs.filter((candidate) => candidate.taskId === run.taskId);
    renderReport('rich', `#/runs/${siblings[0]!.id}?task=${run.taskId}`);
    expect(screen.getByText('1 of 15')).toBeDefined();
    await routed(() => user.click(screen.getByRole('link', { name: 'Next' })));
    expect(screen.getByText('2 of 15')).toBeDefined();
    expect(window.location.hash).toBe(`#/runs/${siblings[1]!.id}?task=${run.taskId}`);
    await routed(() => user.click(screen.getByRole('link', { name: 'Previous' })));
    expect(screen.getByText('1 of 15')).toBeDefined();
  });

  it('hides arm names and leaves room for the review panel in review mode', () => {
    renderReport('rich', `#/runs/${run.id}`, 'review');
    expect(screen.getAllByText('hidden arm').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-slot="review"]')).not.toBeNull();
  });

  describe('with a subagent', () => {
    const delegating = results.runs.find(
      (candidate) => (candidate.measurements.subagentTurns ?? 0) > 0,
    )!;
    const agent = delegating.events.find(
      (event) => event.type === 'tool_call' && event.name === 'Agent',
    )!;

    it('nests the subagent under its Agent call, collapsed, with its turns and tokens', () => {
      renderReport('rich', `#/runs/${delegating.id}`);
      const topLevel = Array.from(
        document.querySelectorAll('.timeline:not(.timeline-nested) > .step > .step-body > .tool'),
      );
      const row = topLevel.find(
        (node) => node.querySelector('.tool-name')?.textContent === 'Agent',
      );
      expect(row).toBeDefined();
      expect(row?.hasAttribute('open')).toBe(false);
      expect(row?.querySelector('.tool-spend')?.textContent).toBe(
        'subagent: 2 turns, 27,960 tokens',
      );
      const nested = Array.from(row?.querySelectorAll('.timeline-nested .tool-name') ?? []).map(
        (node) => node.textContent,
      );
      expect(nested).toEqual(['Grep', 'Read']);
      expect(row?.querySelector('.timeline-nested')?.textContent).toContain('Subagent turn 2');
      expect(
        delegating.events
          .filter((event) => 'parentToolUseId' in event)
          .every(
            (event) =>
              'parentToolUseId' in event &&
              event.parentToolUseId === (agent.type === 'tool_call' ? agent.id : ''),
          ),
      ).toBe(true);
    });

    it('marks a partly estimated cost and shows the reported duration in a tooltip', () => {
      renderReport('rich', `#/runs/${delegating.id}`);
      const facts = document.querySelector('.run-facts')!;
      const cost = within(facts as HTMLElement).getByText(
        `≈ ${formatCurrency(delegating.measurements.costUsd)}`,
      );
      expect(cost.getAttribute('title')).toMatch(/^Claude Code reported \$/);
      const result = delegating.events.findLast((event) => event.type === 'result')!;
      const duration = within(facts as HTMLElement).getByText(
        formatDuration(delegating.measurements.durationMs),
      );
      expect(duration.getAttribute('title')).toBe(
        `Wall clock. Claude Code reported ${formatDuration(result.reportedDurationMs ?? 0)}.`,
      );
      expect(within(facts as HTMLElement).getByText('Subagent turns')).toBeDefined();
    });

    it('marks the estimated cost in the run list', () => {
      renderReport('rich', '#/runs');
      expect(
        screen.getByText(`≈ ${formatCurrency(delegating.measurements.costUsd)}`),
      ).toBeDefined();
    });

    it('lists the tools the run had', () => {
      renderReport('rich', `#/runs/${delegating.id}`);
      expect(document.querySelector('.tools-available')?.textContent).toBe(
        'Agent, Bash, Edit, Glob, Grep, Read, Write, TodoWrite',
      );
    });
  });

  it('says when a run is not in the report', () => {
    renderReport('rich', '#/runs/nope');
    expect(screen.getByRole('heading', { name: 'Run not found' })).toBeDefined();
  });
});

describe('unreadable data', () => {
  it('explains how to generate a report when empty', () => {
    render(<App loaded={loadResults(null)} />);
    expect(screen.getByRole('heading', { name: 'No results in this report' })).toBeDefined();
    expect(screen.getByText('placebo run')).toBeDefined();
  });

  it('names the version it cannot read', () => {
    render(<App loaded={loadResults('{"schemaVersion":7}')} />);
    expect(screen.getByRole('alert').textContent).toContain(
      'The results use schema version 7, and this report reads version 1.',
    );
  });

  it('names the first issue path', () => {
    const data = fixture('minimal');
    render(<App loaded={loadResults(JSON.stringify({ ...data, runs: [{}] }))} />);
    expect(screen.getByRole('alert').textContent).toMatch(/The first problem is at runs\[0\]\./);
  });
});
