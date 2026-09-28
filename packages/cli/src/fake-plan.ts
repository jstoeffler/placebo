import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type FakePlan,
  parseQuestions,
  type RunRequest,
  type TokenUsage,
} from '@placebo-eval/core';

/** Where a checklist judge prompt lists its questions (see core's judge prompts). */
const QUESTIONS_INTRO = 'copying each question verbatim into `question`.';

/** Tokens each configuration file at the run folder's root adds to every turn. */
const CONFIG_TOKENS = 900;

/**
 * The plan of `--runner fake`: a deterministic agent for demos and tests that spends nothing.
 *
 * - A subject run writes the file named after the word "named" in the prompt, if any, and
 *   otherwise only reads. Usage, cost and duration are plausible and grow with each of
 *   `CLAUDE.md` and `AGENTS.md` at the run folder's root, so a treatment that strips one shows a
 *   difference.
 * - A checklist judge answers yes to every question when the change is not empty.
 * - A comparison judge prefers the attempt whose change adds more lines, `a` on a tie.
 */
export function fakePlan(request: RunRequest): FakePlan {
  const properties = propertiesOf(request.outputSchema);
  if (properties.has('answers')) return checklistAnswer(request.prompt);
  if (properties.has('better')) return comparisonAnswer(request.prompt);
  return subjectRun(request);
}

function propertiesOf(schema: RunRequest['outputSchema']): Set<string> {
  const properties = schema?.properties;
  return new Set(
    typeof properties === 'object' && properties !== null ? Object.keys(properties) : [],
  );
}

const JUDGE_TURN: TokenUsage = { input: 900, output: 60, cacheRead: 0, cacheWrite: 0 };

function checklistAnswer(prompt: string): FakePlan {
  const at = prompt.lastIndexOf(QUESTIONS_INTRO);
  const questions = at === -1 ? [] : parseQuestions(prompt.slice(at + QUESTIONS_INTRO.length));
  const yes = prompt.includes('diff --git');
  return {
    steps: [{ usage: JUDGE_TURN }],
    result: {
      costUsd: 0.002,
      durationMs: 1_500,
      apiDurationMs: 1_400,
      structuredOutput: {
        answers: questions.map((question) => ({
          question,
          yes,
          reason: yes ? 'The change addresses it.' : 'The agent changed nothing.',
        })),
      },
    },
  };
}

function comparisonAnswer(prompt: string): FakePlan {
  const a = prompt.indexOf('Attempt a');
  const b = prompt.indexOf('Attempt b');
  const added = (body: string): number =>
    body.split('\n').filter((line) => line.startsWith('+')).length;
  const addedA = a === -1 || b === -1 ? 0 : added(prompt.slice(a, b));
  const addedB = b === -1 ? 0 : added(prompt.slice(b));
  const better = addedB > addedA ? 'b' : 'a';
  return {
    steps: [{ usage: JUDGE_TURN }],
    result: {
      costUsd: 0.002,
      durationMs: 1_500,
      apiDurationMs: 1_400,
      structuredOutput: { better, reason: `Attempt ${better} does more of the task.` },
    },
  };
}

function subjectRun(request: RunRequest): FakePlan {
  const configFiles = ['CLAUDE.md', 'AGENTS.md'].filter((name) =>
    existsSync(join(request.cwd, name)),
  ).length;
  const turn: TokenUsage = {
    input: 1_200 + configFiles * CONFIG_TOKENS,
    output: 240,
    cacheRead: 6_000,
    cacheWrite: 900,
  };
  const path = namedFile(request.prompt);
  const result = {
    costUsd: 0.0134 + configFiles * 0.0027,
    durationMs: 8_200 + configFiles * 600,
    apiDurationMs: 6_100 + configFiles * 500,
  };
  if (path === undefined) {
    return {
      steps: [
        { text: 'Looking around the repository.' },
        { tool: 'Glob', input: { pattern: '*' } },
        { usage: turn },
        { text: 'Nothing to change.' },
      ],
      result,
    };
  }
  const content = `${path} was written by the fake runner of placebo.\n`;
  return {
    steps: [
      { text: 'Looking around the repository.' },
      { tool: 'Glob', input: { pattern: '*' } },
      { usage: turn },
      { tool: 'Write', input: { file_path: path, content } },
      { write: { path, content } },
      { usage: turn },
      { text: `Wrote ${path}.` },
    ],
    result,
  };
}

/** The file after the word "named", e.g. `PLACEBO.md` in "Add a file named PLACEBO.md at…". */
export function namedFile(prompt: string): string | undefined {
  const name = /\bnamed\s+[`'"]?([\w./-]*\w)/i.exec(prompt)?.[1];
  if (name === undefined || name.startsWith('/') || name.split('/').includes('..')) {
    return undefined;
  }
  return name;
}
