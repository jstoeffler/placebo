import { armName, type ArmName } from '../domain/arm.js';
import {
  COMPARISON_JUDGE_OUTPUT_SCHEMA,
  ComparisonJudgeOutput,
  type Grade,
  type GraderRef,
} from '../domain/grade.js';
import type { Run } from '../domain/run.js';
import type { GraderSpec, Task } from '../domain/suite.js';
import type { RunId } from '../kernel/ids.js';
import type { Random } from '../kernel/random.js';
import { err, ok } from '../kernel/result.js';
import type { JudgeContext } from './context.js';
import { commandEvidence } from './evidence.js';
import { errorGrade, refOf } from './grades.js';
import { askJudge, inJudgeFolder, issuesText, type JudgeValidator } from './judge.js';
import { COMPARISON_SYSTEM_PROMPT, comparisonPrompt } from './judge-prompts.js';

type ComparisonSpec = Extract<GraderSpec, { type: 'comparison' }>;

export interface ComparisonInput extends JudgeContext {
  /** Every run of the experiment; only runs of `task` are used. */
  readonly runs: readonly Run[];
  readonly task: Task;
  /** The treatment arm whose runs are compared with control runs. */
  readonly treatment: ArmName;
  /** Seeded; draws the control opponent and the `a`/`b` position of every comparison. */
  readonly random: Random;
}

/** A comparison grade and the treatment run it belongs on. */
export interface ComparisonGrade {
  readonly runId: RunId;
  readonly grade: Grade;
}

/**
 * Runs every `comparison` grader of `task`, once all runs of the experiment exist. For each
 * treatment run of the task, in the order given, draws a random control run of the same task and
 * a random position, shows the two changes, each with its stored command graders' results, to the
 * judge as `a` and `b` with arms hidden, and asks
 * which is better. Returns one grade per treatment run and comparison grader, to store on the
 * treatment run: score is the fraction of repeats preferring the treatment run (1 or 0 with one
 * repeat), `preferred` is true when that fraction is above one half. All repeats of a pairing use
 * the same position.
 *
 * `agentic` is ignored for comparisons: the judge always runs one turn, tool-less, in an empty
 * judge folder from `executor`, because an agentic judge would need to read two run folders at
 * once. The folder is removed once the judge finishes, also on failure.
 *
 * A pairing whose judge fails, or a treatment run with no control run to face, yields an error
 * grade scored 0. `RunnerInfraError` propagates.
 */
export async function gradeComparisons(input: ComparisonInput): Promise<ComparisonGrade[]> {
  const ofTask = input.runs.filter((run) => run.taskId === input.task.id);
  const controls = ofTask.filter((run) => run.arm.kind === 'control');
  const treatments = ofTask.filter(
    (run) => run.arm.kind === 'treatment' && armName(run.arm) === input.treatment,
  );
  const grades: ComparisonGrade[] = [];
  for (const [index, spec] of input.task.graders.entries()) {
    if (spec.type !== 'comparison') continue;
    const ref = refOf(spec, index);
    for (const run of treatments) {
      grades.push({ runId: run.id, grade: await compareOne(spec, ref, run, controls, input) });
    }
  }
  return grades;
}

async function compareOne(
  spec: ComparisonSpec,
  ref: GraderRef,
  run: Run,
  controls: readonly Run[],
  input: ComparisonInput,
): Promise<Grade> {
  const opponent =
    controls.length === 0 ? undefined : controls[input.random.int(0, controls.length)];
  if (opponent === undefined) {
    return errorGrade(ref, 'judge', 'no control run of this task to compare with');
  }
  const position = input.random.next() < 0.5 ? 'a' : 'b';
  const attempt = (of: Run) => ({
    diff: of.change.diff,
    commands: commandEvidence(input.task, of.grades),
  });
  const [a, b] = position === 'a' ? [run, opponent] : [opponent, run];
  const query = {
    prompt: comparisonPrompt({ taskPrompt: input.task.prompt, a: attempt(a), b: attempt(b) }),
    systemPrompt: COMPARISON_SYSTEM_PROMPT,
    outputSchema: COMPARISON_JUDGE_OUTPUT_SCHEMA,
  };

  const raw: unknown[] = [];
  const reasons: string[] = [];
  let wins = 0;
  const asked = await inJudgeFolder(input, undefined, async (folder) => {
    for (let repeat = 1; repeat <= spec.repeats; repeat++) {
      const answer = await askJudge(input, query, folder, validateComparison);
      if (!answer.ok) {
        const which =
          spec.repeats > 1 ? ` (repeat ${String(repeat)} of ${String(spec.repeats)})` : '';
        return `${answer.error}${which}`;
      }
      raw.push(answer.value.raw);
      reasons.push(answer.value.value.reason);
      if (answer.value.value.better === position) wins += 1;
    }
    return undefined;
  });
  const failure = asked.ok ? asked.value : asked.error;
  if (failure !== undefined) return errorGrade(ref, 'judge', failure);

  const score = wins / spec.repeats;
  return {
    grader: ref,
    kind: 'judge',
    score,
    detail: {
      type: 'comparison',
      opponentRunId: opponent.id,
      position,
      preferred: score > 0.5,
      reason:
        reasons.length === 1
          ? reasons.join('')
          : reasons.map((r, i) => `${String(i + 1)}: ${r}`).join('\n'),
      model: input.judgeModel,
      raw,
    },
  };
}

const validateComparison: JudgeValidator<ComparisonJudgeOutput> = (raw) => {
  const parsed = ComparisonJudgeOutput.safeParse(raw);
  return parsed.success ? ok(parsed.data) : err(issuesText(parsed.error.issues));
};
