import type { Warning } from '@placebo-eval/core/results';

const SOURCE_LABEL = {
  global_config: 'the global Claude Code config file',
  managed_settings: 'managed policy settings',
  claude_ai_connectors: 'claude.ai connectors',
} as const;

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** One plain sentence per warning, in the wording of brief §13. */
function warningSentence(warning: Warning): string {
  switch (warning.type) {
    case 'few_tasks':
      return `With ${String(warning.taskCount)} ${warning.taskCount === 1 ? 'task' : 'tasks'}, fewer than ${String(warning.threshold)}, these results describe these tasks, not the repo.`;
    case 'judge_equals_subject':
      return `The judge model is the subject model (${warning.model}), so the judge may favour its own work; pin a different judge model.`;
    case 'patch_outside_surface':
      return `The variant patch of ${warning.variant} touches files outside the configuration surface: ${list(warning.paths)}.`;
    case 'dead_task':
      return `Every arm scored zero on ${warning.taskId}, so it is flagged as unsolvable or brittle and excluded from verdicts.`;
    case 'isolation_residual':
      return `Project-only settings do not keep out ${list(warning.sources.map((source) => SOURCE_LABEL[source]))}, which may reach every arm.`;
  }
}

export function Warnings({ warnings }: { readonly warnings: readonly Warning[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="warnings" aria-labelledby="warnings-heading">
      <h2 id="warnings-heading" className="warnings-heading">
        {warnings.length === 1 ? 'One warning' : `${String(warnings.length)} warnings`}
      </h2>
      <ul>
        {warnings.map((warning, i) => (
          <li key={i}>{warningSentence(warning)}</li>
        ))}
      </ul>
    </section>
  );
}
