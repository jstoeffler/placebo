// Every judge prompt in one place, so a person can review exactly what a judge is told. Judges
// never learn which arm produced a result: nothing here or in the inputs names an arm.

/** Last characters of a command's stdout or stderr shown to a checklist judge. */
export const COMMAND_OUTPUT_TAIL = 10_000;

const NO_SPECULATION =
  'Do not speculate about how the agent was configured or which setup produced the work.';

/** System prompt of a checklist judge. */
export const CHECKLIST_SYSTEM_PROMPT = [
  'You grade the work of a coding agent on one task.',
  'You receive the task, the change the agent made to the repository as a unified diff, and the results of checks run afterwards.',
  'Answer each question with yes or no, using only this evidence. Answer yes only when the evidence clearly supports it.',
  'Give a one-sentence reason for each answer.',
  NO_SPECULATION,
].join('\n');

/** Appended to the checklist system prompt when the judge may read the repository. */
export const AGENTIC_ADDENDUM =
  'The repository as the agent left it is in the current directory. Read files when the change alone cannot answer a question.';

/** System prompt of a comparison judge. */
export const COMPARISON_SYSTEM_PROMPT = [
  'You compare two attempts by a coding agent at the same task, labeled a and b.',
  'Each attempt is shown as the change it made to the repository, as a unified diff, followed by the results of checks run afterwards when there were any.',
  'Decide which attempt better accomplishes the task: correctness first, then completeness, then code quality and staying within scope.',
  'You must choose a or b; ties are not allowed. The order of the attempts is random and means nothing.',
  'Give a one-sentence reason.',
  NO_SPECULATION,
].join('\n');

/** The result of one command grader, as shown to a judge. */
export interface CommandEvidence {
  readonly command: string;
  /** Null when killed by a signal; undefined when the command could not run at all. */
  readonly exitCode: number | null | undefined;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the command could not run, if it could not. */
  readonly error?: string;
}

/** User prompt of a checklist judge. */
export function checklistPrompt(input: {
  readonly taskPrompt: string;
  readonly diff: string;
  readonly commands: readonly CommandEvidence[];
  readonly questions: readonly string[];
}): string {
  const sections = [
    section('Task given to the agent', input.taskPrompt.trim()),
    section('Change', changeBlock(input.diff)),
  ];
  if (input.commands.length > 0) sections.push(checksSection(input.commands, '##'));
  sections.push(
    section(
      'Questions',
      [
        'Answer every question, in this order, copying each question verbatim into `question`.',
        '',
        ...input.questions.map((question, i) => `${String(i + 1)}. ${question}`),
      ].join('\n'),
    ),
  );
  return sections.join('\n\n');
}

/** User prompt of a comparison judge. */
export function comparisonPrompt(input: {
  readonly taskPrompt: string;
  readonly a: ComparedAttempt;
  readonly b: ComparedAttempt;
}): string {
  return [
    section('Task given to the agent', input.taskPrompt.trim()),
    section('Attempt a', attemptBody(input.a)),
    section('Attempt b', attemptBody(input.b)),
    'Which attempt better accomplishes the task, a or b?',
  ].join('\n\n');
}

/** One attempt as a comparison judge sees it: its change and its command graders' results. */
export interface ComparedAttempt {
  readonly diff: string;
  readonly commands: readonly CommandEvidence[];
}

function attemptBody(attempt: ComparedAttempt): string {
  const change = changeBlock(attempt.diff);
  return attempt.commands.length === 0
    ? change
    : `${change}\n\n${checksSection(attempt.commands, '###')}`;
}

function checksSection(commands: readonly CommandEvidence[], level: '##' | '###'): string {
  return section('Checks run after the agent finished', commands.map(evidence).join('\n\n'), level);
}

function section(title: string, body: string, level: '##' | '###' = '##'): string {
  return `${level} ${title}\n\n${body}`;
}

function changeBlock(diff: string): string {
  return diff.trim() === '' ? 'No change: the agent modified no file.' : fenced(diff, 'diff');
}

function evidence(command: CommandEvidence): string {
  const head = `Command: ${command.command}`;
  if (command.error !== undefined) return `${head}\nCould not run: ${command.error}`;
  const exit =
    command.exitCode === null || command.exitCode === undefined
      ? 'Killed by a signal.'
      : `Exit code: ${String(command.exitCode)}`;
  const streams = [
    command.stdout.trim() === '' ? '' : `stdout:\n${fenced(tail(command.stdout), '')}`,
    command.stderr.trim() === '' ? '' : `stderr:\n${fenced(tail(command.stderr), '')}`,
  ].filter((part) => part !== '');
  return [head, exit, ...streams].join('\n');
}

function tail(text: string): string {
  return text.length <= COMMAND_OUTPUT_TAIL
    ? text
    : `[first ${String(text.length - COMMAND_OUTPUT_TAIL)} characters omitted]\n${text.slice(-COMMAND_OUTPUT_TAIL)}`;
}

/** A code fence longer than any backtick run in `content`, so the content cannot close it. */
function fenced(content: string, lang: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${content.replace(/\n$/, '')}\n${fence}`;
}
