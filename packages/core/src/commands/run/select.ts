import { CONTROL, type Arm } from '../../domain/arm.js';
import type { Suite, Task, Variant } from '../../domain/suite.js';
import type { TaskId, VariantName } from '../../kernel/ids.js';
import { err, ok, type Result } from '../../kernel/result.js';

/**
 * The tasks to run, in suite order. Without a filter, all of them. A filter naming a task the
 * suite does not have is an error rather than a silent skip, so a typo never shrinks an
 * experiment unnoticed.
 */
export function selectTasks(suite: Suite, filter?: readonly TaskId[]): Result<Task[], string> {
  if (filter === undefined) return ok([...suite.tasks]);
  const known = new Set<string>(suite.tasks.map((task) => task.id));
  const unknown = filter.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return err(`the suite has no task ${unknown.map((id) => `"${id}"`).join(', ')}`);
  }
  const wanted = new Set<string>(filter);
  const tasks = suite.tasks.filter((task) => wanted.has(task.id));
  return tasks.length === 0 ? err('no task selected') : ok(tasks);
}

/**
 * The arms of the experiment: control first, then a treatment per selected variant in suite
 * order. A filter naming a variant the suite does not have is an error.
 */
export function selectArms(suite: Suite, filter?: readonly VariantName[]): Result<Arm[], string> {
  const variants = Object.entries(suite.variants) as [VariantName, Variant][];
  if (filter !== undefined) {
    const unknown = filter.filter((name) => !(name in suite.variants));
    if (unknown.length > 0) {
      return err(`the suite has no variant ${unknown.map((name) => `"${name}"`).join(', ')}`);
    }
  }
  const wanted = filter === undefined ? undefined : new Set<string>(filter);
  const treatments: Arm[] = variants
    .filter(([name]) => wanted === undefined || wanted.has(name))
    .map(([variant, { patch }]) => ({ kind: 'treatment', variant, patch }));
  return treatments.length === 0 ? err('no variant selected') : ok([CONTROL, ...treatments]);
}
