import type { Arm } from '../../domain/arm.js';
import { outsideConfigurationSurface, patchPaths } from '../../domain/patch-paths.js';
import type { Suite } from '../../domain/suite.js';
import { FEW_TASKS_THRESHOLD, type Warning } from '../../domain/warnings.js';
import { judgeEqualsSubject } from '../../graders/judge-equals-subject.js';

/**
 * The warnings known before anything is spent (brief §13): the judge model equals the subject
 * model, a variant patch touches paths outside the configuration surface, fewer tasks than
 * `FEW_TASKS_THRESHOLD`.
 */
export function upfrontWarnings(input: {
  readonly suite: Pick<Suite, 'model' | 'judgeModel'>;
  readonly arms: readonly Arm[];
  readonly taskCount: number;
  /** Decoded variant patch of every treatment, by patch path. */
  readonly patchText: (patch: string) => string;
}): Warning[] {
  const warnings: Warning[] = [];
  const judge = judgeEqualsSubject(input.suite);
  if (judge !== undefined) warnings.push(judge);
  for (const arm of input.arms) {
    if (arm.kind === 'control') continue;
    const paths = outsideConfigurationSurface(patchPaths(input.patchText(arm.patch)));
    if (paths.length > 0) {
      warnings.push({ type: 'patch_outside_surface', variant: arm.variant, paths });
    }
  }
  if (input.taskCount < FEW_TASKS_THRESHOLD) {
    warnings.push({
      type: 'few_tasks',
      taskCount: input.taskCount,
      threshold: FEW_TASKS_THRESHOLD,
    });
  }
  return warnings;
}

/** One line of plain language per warning, for the `message` progress event. */
export function describeWarning(warning: Warning): string {
  switch (warning.type) {
    case 'judge_equals_subject':
      return `the judge model is the subject model (${warning.model}); a model grading its own work favours it`;
    case 'patch_outside_surface':
      return `variant "${warning.variant}" touches files outside the configuration surface: ${warning.paths.join(', ')}`;
    case 'few_tasks':
      return `only ${String(warning.taskCount)} task${warning.taskCount === 1 ? '' : 's'} (fewer than ${String(warning.threshold)}): results describe these tasks, not the repo in general`;
    case 'dead_task':
      return `task "${warning.taskId}" scored zero in every arm; it is left out of the verdicts`;
    case 'isolation_residual':
      return `configuration outside the project can still reach runs: ${warning.sources.join(', ')}`;
    case 'ancestor_configuration':
      return `Claude Code loads configuration from above the run folders into every arm: ${warning.paths.join(', ')}`;
  }
}

/**
 * The up-front warnings merged with the ones statistics found once runs exist. `few_tasks` and
 * `judge_equals_subject` come from statistics when it reports them (its task count leaves dead
 * tasks out); every other warning is kept once.
 */
export function mergeWarnings(
  upfront: readonly Warning[],
  computed: readonly Warning[],
): Warning[] {
  const merged: Warning[] = [...computed];
  const computedTypes = new Set(computed.map((warning) => warning.type));
  const seen = new Set(computed.map((warning) => JSON.stringify(warning)));
  for (const warning of upfront) {
    const replaced =
      (warning.type === 'few_tasks' || warning.type === 'judge_equals_subject') &&
      computedTypes.has(warning.type);
    const key = JSON.stringify(warning);
    if (replaced || seen.has(key)) continue;
    seen.add(key);
    merged.push(warning);
  }
  return merged;
}
