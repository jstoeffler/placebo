import { describe, expect, it } from 'vitest';
import { formatSuiteIssues, parseSuite, type SuiteIssue } from './parse-suite.js';

/** Brief Appendix A, verbatim. */
const APPENDIX_A = `# .placebo/suite.yaml
repo: .
commit: 3f9a1c2e
model: claude-sonnet-5            # written by init from your current default
judge_model: claude-opus-5-5      # written by init from the current Opus
runs: 5
parallelism: 4
setup: pnpm install --frozen-lockfile

variants:
  none:   { patch: variants/none.patch }
  tests:  { patch: variants/always-run-tests.patch }

tasks:
  - id: refund-rounding
    prompt: |
      Refunds of 10.005 are rounded to 10.00 instead of 10.01.
      Fix the rounding. \`refund(amount)\` in src/money.ts must keep its signature.
    graders:
      - { type: command, run: "pnpm vitest run tests/hidden/refund.spec.ts", hidden: [tests/hidden/refund.spec.ts] }
      - { type: file_modified, path: src/money.ts }
      - { type: checklist, questions: tasks/refund-rounding/checklist.md }
      - { type: comparison }
    review:
      questions: tasks/refund-rounding/checklist.md
`;

const MINIMAL = `commit: abcdef1
model: m
judge_model: j
variants:
  none: { patch: variants/none.patch }
tasks:
  - id: t
    prompt: do it
    graders:
      - { type: file_exists, path: a.ts }
`;

function issues(text: string): SuiteIssue[] {
  const result = parseSuite(text);
  if (result.ok) throw new Error('expected issues');
  return result.error;
}

describe('parseSuite', () => {
  it('parses brief Appendix A verbatim into a camelCase suite with defaults', () => {
    const result = parseSuite(APPENDIX_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      repo: '.',
      commit: '3f9a1c2e',
      model: 'claude-sonnet-5',
      judgeModel: 'claude-opus-5-5',
      runs: 5,
      parallelism: 4,
      setup: 'pnpm install --frozen-lockfile',
      sandbox: true,
      margins: { passRate: 5, cost: 10, tokens: 10, duration: 15 },
      variants: {
        none: { patch: 'variants/none.patch' },
        tests: { patch: 'variants/always-run-tests.patch' },
      },
      tasks: [
        {
          id: 'refund-rounding',
          prompt:
            'Refunds of 10.005 are rounded to 10.00 instead of 10.01.\nFix the rounding. `refund(amount)` in src/money.ts must keep its signature.\n',
          graders: [
            {
              type: 'command',
              run: 'pnpm vitest run tests/hidden/refund.spec.ts',
              hidden: ['tests/hidden/refund.spec.ts'],
            },
            { type: 'file_modified', path: 'src/money.ts' },
            {
              type: 'checklist',
              questions: 'tasks/refund-rounding/checklist.md',
              agentic: false,
              repeats: 1,
            },
            { type: 'comparison', agentic: false, repeats: 1 },
          ],
          review: { questions: 'tasks/refund-rounding/checklist.md' },
        },
      ],
    });
    expect(result.value).not.toHaveProperty('limits');
  });

  it('applies defaults when optional keys are absent', () => {
    const result = parseSuite(MINIMAL);
    expect(result.ok && result.value).toMatchObject({
      repo: '.',
      runs: 5,
      parallelism: 4,
      sandbox: true,
      margins: { passRate: 5, cost: 10, tokens: 10, duration: 15 },
    });
    expect(result.ok && 'setup' in result.value).toBe(false);
  });

  it('maps snake_case limits and margins, keeping unspecified margin defaults', () => {
    const result = parseSuite(
      `${MINIMAL}limits: { max_turns: 40, max_budget_usd: 2.5, max_duration_ms: 600000 }\nmargins: { pass_rate: 10 }\nsandbox: false\n`,
    );
    expect(result.ok && result.value).toMatchObject({
      sandbox: false,
      limits: { maxTurns: 40, maxBudgetUsd: 2.5, maxDurationMs: 600000 },
      margins: { passRate: 10, cost: 10, tokens: 10, duration: 15 },
    });
  });

  it('rejects camelCase keys in the file with a hint', () => {
    expect(issues(MINIMAL.replace('judge_model', 'judgeModel'))).toEqual([
      {
        path: 'judgeModel',
        line: 3,
        message: 'unknown key; suite.yaml uses snake_case, write "judge_model"',
      },
      { path: 'judge_model', line: 1, message: 'is required' },
    ]);
    expect(issues(`${MINIMAL}margins: { passRate: 3 }\n`)[0]).toMatchObject({
      path: 'margins.passRate',
      line: 11,
    });
  });

  it('reports missing required keys with snake_case paths', () => {
    const found = issues('commit: abcdef1\n');
    expect(found.map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'model: is required',
      'judge_model: is required',
      'variants: is required',
      'tasks: is required',
    ]);
  });

  it('locates nested errors by path and line', () => {
    const text = MINIMAL.replace(
      '{ type: file_exists, path: a.ts }',
      '{ type: file_exits, path: a.ts }',
    );
    expect(issues(text)).toEqual([
      {
        path: 'tasks[0].graders[0].type',
        line: 10,
        message:
          'type must be one of command, file_exists, file_modified, regex, tool_used, checklist, comparison',
      },
    ]);
  });

  it('rejects unknown keys on graders', () => {
    const text = MINIMAL.replace('path: a.ts', 'path: a.ts, hidden: [x]');
    expect(issues(text)[0]).toMatchObject({ path: 'tasks[0].graders[0]', line: 10 });
    expect(issues(text)[0]?.message).toContain('hidden');
  });

  it('asks to quote commits YAML reads as numbers', () => {
    expect(issues(MINIMAL.replace('abcdef1', '1234567'))).toEqual([
      {
        path: 'commit',
        line: 1,
        message: 'commit must be a string; quote it in YAML, e.g. commit: "0123456"',
      },
    ]);
  });

  it('reports duplicate task ids at the duplicate', () => {
    const text = `${MINIMAL}  - id: t\n    prompt: again\n    graders: [{ type: tool_used, tool: Bash }]\n`;
    expect(issues(text)).toEqual([
      { path: 'tasks[1].id', line: 11, message: 'duplicate task id "t"' },
    ]);
  });

  it('reports YAML syntax errors with their line', () => {
    const found = issues('commit: abcdef1\nmodel: [unclosed\n');
    expect(found[0]?.path).toBe('');
    expect(found[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['', 'suite.yaml must be a mapping of keys to values'],
    ['- a\n- b\n', 'suite.yaml must be a mapping of keys to values'],
  ])('rejects a non-mapping document %j', (text, message) => {
    expect(issues(text)).toEqual([{ path: '', message }]);
  });

  it('rejects an invalid regex pattern and a reserved variant name', () => {
    const text = MINIMAL.replace('none: {', 'control: {').replace(
      '{ type: file_exists, path: a.ts }',
      '{ type: regex, pattern: "(" }',
    );
    expect(issues(text).map((issue) => `${issue.path}: ${issue.message}`)).toEqual([
      'variants.control: variant name "control" is reserved',
      'tasks[0].graders[0].pattern: pattern is not a valid regular expression',
    ]);
  });
});

describe('formatSuiteIssues', () => {
  it('prints one issue per line with file, line and path', () => {
    expect(
      formatSuiteIssues(
        [
          { path: 'tasks[0].prompt', line: 12, message: 'prompt must not be empty' },
          { path: '', message: 'suite.yaml must be a mapping of keys to values' },
        ],
        '.placebo/suite.yaml',
      ),
    ).toBe(
      '.placebo/suite.yaml:12 tasks[0].prompt: prompt must not be empty\n.placebo/suite.yaml suite.yaml must be a mapping of keys to values',
    );
  });
});
