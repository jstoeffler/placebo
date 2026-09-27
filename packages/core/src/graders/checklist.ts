import {
  CHECKLIST_JUDGE_OUTPUT_SCHEMA,
  ChecklistJudgeOutput,
  type Grade,
  type GraderRef,
} from '../domain/grade.js';
import type { ChecklistAnswer } from '../domain/review.js';
import type { GraderSpec } from '../domain/suite.js';
import { err, ok } from '../kernel/result.js';
import type { GradingContext } from './context.js';
import { errorGrade } from './grades.js';
import {
  askJudge,
  inJudgeFolder,
  issuesText,
  type JudgeAnswer,
  type JudgeValidator,
  messageOf,
  spendOf,
} from './judge.js';
import {
  AGENTIC_ADDENDUM,
  CHECKLIST_SYSTEM_PROMPT,
  checklistPrompt,
  type CommandEvidence,
} from './judge-prompts.js';
import { parseQuestions } from './questions.js';

type ChecklistSpec = Extract<GraderSpec, { type: 'checklist' }>;

/**
 * Asks the judge the questions of `spec.questions` about the run, `spec.repeats` times.
 *
 * The judge sees the task prompt, the change and the command graders' results, never the arm.
 * Answers are matched to questions by position; the judge must answer every question. Score is
 * the count of yes, averaged over repeats; `passed` stays undefined. The detail's `answers` are
 * per question the majority over repeats (yes only if more than half said yes), and `raw` holds
 * every repeat's answer verbatim.
 *
 * `agentic: true` (opt-in) runs the judge with read-only tools and no turn cap in a copy of the run
 * folder stripped of every configuration-surface path (brief §9, ADR 0007), made after hidden
 * files entered the run folder. Otherwise it runs one turn, tool-less, in an empty judge folder.
 * Either folder is removed once the judge finishes, also on failure. No setting sources load.
 *
 * Any repeat failing (no answer, invalid answer, wrong question count) makes the whole grade an
 * error grade scored 0; `RunnerInfraError` propagates.
 */
export async function gradeChecklist(
  spec: ChecklistSpec,
  ref: GraderRef,
  ctx: Pick<
    GradingContext,
    'task' | 'change' | 'suiteFiles' | 'runFolder' | 'runner' | 'judgeModel' | 'executor'
  >,
  commands: readonly CommandEvidence[],
): Promise<Grade> {
  let questions: string[];
  try {
    const file = await ctx.suiteFiles(spec.questions);
    questions = parseQuestions(typeof file === 'string' ? file : new TextDecoder().decode(file));
  } catch (error) {
    return errorGrade(ref, 'judge', `could not read ${spec.questions}: ${messageOf(error)}`);
  }
  if (questions.length === 0) {
    return errorGrade(ref, 'judge', `${spec.questions} contains no question (expected list items)`);
  }

  const prompt = checklistPrompt({
    taskPrompt: ctx.task.prompt,
    diff: ctx.change.diff,
    commands,
    questions,
  });
  const query = {
    prompt,
    systemPrompt: spec.agentic
      ? `${CHECKLIST_SYSTEM_PROMPT}\n${AGENTIC_ADDENDUM}`
      : CHECKLIST_SYSTEM_PROMPT,
    outputSchema: CHECKLIST_JUDGE_OUTPUT_SCHEMA,
    agentic: spec.agentic,
  };
  const validate: JudgeValidator<ChecklistJudgeOutput> = (raw) => {
    const parsed = ChecklistJudgeOutput.safeParse(raw);
    if (!parsed.success) return err(issuesText(parsed.error.issues));
    if (parsed.data.answers.length !== questions.length) {
      return err(
        `expected ${String(questions.length)} answers, one per question, got ${String(parsed.data.answers.length)}`,
      );
    }
    return ok(parsed.data);
  };

  const given: JudgeAnswer<ChecklistJudgeOutput>[] = [];
  const asked = await inJudgeFolder(
    ctx,
    spec.agentic ? ctx.runFolder : undefined,
    async (folder) => {
      for (let repeat = 1; repeat <= spec.repeats; repeat++) {
        const answer = await askJudge(ctx, query, folder, validate);
        if (!answer.ok) {
          const which =
            spec.repeats > 1 ? ` (repeat ${String(repeat)} of ${String(spec.repeats)})` : '';
          return `${answer.error}${which}`;
        }
        given.push(answer.value);
      }
      return undefined;
    },
  );
  const failure = asked.ok ? asked.value : asked.error;
  if (failure !== undefined) return errorGrade(ref, 'judge', failure);

  const repeats = given.map((answer) => answer.value);
  const raw = given.map((answer) => answer.raw);
  const answers: ChecklistAnswer[] = questions.map((question, i) => {
    const replies = repeats.flatMap((output) => output.answers.slice(i, i + 1));
    const yesCount = replies.filter((a) => a.yes).length;
    const note =
      replies.length === 1
        ? replies.map((a) => a.reason).join('')
        : replies
            .map((a, r) => `${String(r + 1)}: ${a.yes ? 'yes' : 'no'}, ${a.reason}`)
            .join('\n');
    return { question, yes: yesCount * 2 > replies.length, note };
  });
  const score =
    repeats.reduce((sum, output) => sum + output.answers.filter((a) => a.yes).length, 0) /
    repeats.length;
  const reasoning = answers
    .map((a, i) => `${String(i + 1)}. ${a.question} ${a.yes ? 'Yes' : 'No'}: ${a.note ?? ''}`)
    .join('\n');

  return {
    grader: ref,
    kind: 'judge',
    score,
    detail: {
      type: 'judge',
      model: ctx.judgeModel,
      reasoning,
      raw,
      answers,
      spend: spendOf(given),
    },
  };
}
