/** The task every repo gets: it needs nothing but a README-level understanding of the repo. */
export const EXAMPLE_TASK = {
  id: 'describe-repo',
  prompt:
    'Add a file named PLACEBO.md at the repository root containing one paragraph that describes what this repository does and how to run its tests. Do not change anything else.',
  checklist: 'tasks/describe-repo/checklist.md',
} as const;

export const EXAMPLE_CHECKLIST = [
  '- Is PLACEBO.md a single paragraph?',
  '- Does PLACEBO.md describe what the repository does in a way its code confirms?',
  "- Does PLACEBO.md give a command that runs the repository's tests?",
  '',
].join('\n');

/** Keeps results out of git; the suite itself is reviewed like code. */
export const SUITE_GITIGNORE = 'runs/\nreports/\n';

export interface SuiteTemplate {
  readonly commit: string;
  readonly model: string;
  readonly modelNote: string;
  readonly judgeModel: string;
  readonly judgeNote: string;
  readonly setup?: string;
  /** Path of the none variant's patch, when the repo has configuration to strip. */
  readonly nonePatch?: string;
}

/** A plain YAML scalar when it is one, otherwise a double-quoted (JSON) string. */
function scalar(value: string): string {
  return /^[A-Za-z0-9_./@][A-Za-z0-9_./@ =+-]*$/.test(value) && !value.endsWith(' ')
    ? value
    : JSON.stringify(value);
}

/**
 * Lines with trailing notes, the notes aligned at the column of the brief's Appendix A, or
 * further right when a line is longer.
 */
function noted(lines: readonly (readonly [line: string, note: string])[]): string[] {
  const width = Math.max(33, ...lines.map(([line]) => line.length));
  return lines.map(([line, note]) => `${line.padEnd(width)} # ${note}`);
}

/**
 * `suite.yaml` in the shape and key order of the brief's Appendix A, snake_case, with the commit
 * quoted so YAML never reads it as a number.
 */
export function suiteYaml(input: SuiteTemplate): string {
  const lines = [
    '# .placebo/suite.yaml',
    'repo: .',
    `commit: "${input.commit}"`,
    ...noted([
      [`model: ${scalar(input.model)}`, input.modelNote],
      [`judge_model: ${scalar(input.judgeModel)}`, input.judgeNote],
    ]),
    'runs: 5',
    'parallelism: 4',
    ...(input.setup === undefined ? [] : [`setup: ${scalar(input.setup)}`]),
    '',
    ...(input.nonePatch === undefined
      ? [
          'variants: {}',
          '  # Declare a treatment here, e.g. `rule: { patch: variants/rule.patch }`, with a patch',
          '  # made by `git diff` after adding the rule to test.',
        ]
      : ['variants:', `  none:   { patch: ${scalar(input.nonePatch)} }`]),
    '',
    'tasks:',
    `  - id: ${EXAMPLE_TASK.id}`,
    '    prompt: |',
    `      ${EXAMPLE_TASK.prompt}`,
    '    graders:',
    '      - { type: file_exists, path: PLACEBO.md }',
    `      - { type: checklist, questions: ${EXAMPLE_TASK.checklist} }`,
    '      - { type: comparison }',
    '    review:',
    `      questions: ${EXAMPLE_TASK.checklist}`,
    '',
  ];
  return lines.join('\n');
}
