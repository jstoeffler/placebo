import { z } from 'zod';
import { hashCanonical, sha256 } from '../kernel/hash.js';
import { CommitSha, Sha256 } from '../kernel/ids.js';
import type { Suite, Task } from './suite.js';

/**
 * The content hashes that identify a run for comparison (ADR 0006). Two runs with equal keys are
 * comparable no matter which experiment or machine produced them.
 */
export const RunKey = z.strictObject({
  taskHash: Sha256,
  variantHash: Sha256,
  /** Full commit id of the snapshot. */
  commitHash: CommitSha,
  /** Full model ID. */
  subjectModel: z.string().min(1),
  claudeCodeVersion: z.string().min(1),
});
export type RunKey = z.infer<typeof RunKey>;

/** Contents of suite files, keyed by path relative to `.placebo/`. */
export type SuiteFiles = ReadonlyMap<string, string | Uint8Array>;

/** Where a hidden file's content lives, relative to `.placebo/`. */
export function hiddenFileSource(taskId: string, hiddenPath: string): string {
  return `tasks/${taskId}/${hiddenPath}`;
}

/** A file a task references: where it is read from, and the name it is hashed under. */
interface TaskFile {
  /** Relative to `.placebo/`. */
  readonly source: string;
  /** `hidden:<destination>` for hidden files, the questions path otherwise; never contains the task id implicitly. */
  readonly name: string;
}

function taskFiles(task: Task): TaskFile[] {
  const byName = new Map<string, TaskFile>();
  for (const grader of task.graders) {
    if (grader.type === 'command') {
      for (const hidden of grader.hidden ?? []) {
        byName.set(`hidden:${hidden}`, {
          source: hiddenFileSource(task.id, hidden),
          name: `hidden:${hidden}`,
        });
      }
    }
    if (grader.type === 'checklist')
      byName.set(grader.questions, { source: grader.questions, name: grader.questions });
  }
  if (task.review)
    byName.set(task.review.questions, {
      source: task.review.questions,
      name: task.review.questions,
    });
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Every file a task references, relative to `.placebo/`: hidden files of `command` graders,
 * checklist questions, and review questions. Sorted and unique.
 */
export function taskFilePaths(task: Task): string[] {
  return [...new Set(taskFiles(task).map((file) => file.source))].sort();
}

/**
 * Task hash: the prompt, the parsed graders (defaults applied, so spelling a default out does
 * not change the hash), the review questions path, and the SHA-256 of every referenced file,
 * hidden files named by their destination in the run folder. The task id is deliberately
 * excluded so renaming a task keeps its history. Throws if `files` lacks a referenced path,
 * because a partial hash would be silently wrong.
 */
export function hashTask(task: Task, files: SuiteFiles): Sha256 {
  return hashCanonical({
    prompt: task.prompt,
    graders: task.graders,
    review: task.review,
    files: taskFiles(task).map((file) => ({ name: file.name, sha256: digest(file.source, files) })),
  });
}

/** Variant hash: SHA-256 of the patch bytes. The control arm has no patch and hashes `''`. */
export function hashVariant(patch: string | Uint8Array | null): Sha256 {
  return sha256(patch ?? '');
}

/** A single hash for a run key, e.g. for indexing. */
export function hashRunKey(key: RunKey): Sha256 {
  return hashCanonical(key);
}

/**
 * Suite hash (an experiment pin): the parsed suite plus the SHA-256 of every file it references
 * (variant patches and all task files). Equal suites hash equally regardless of YAML formatting.
 */
export function hashSuite(suite: Suite, files: SuiteFiles): Sha256 {
  const paths = new Set<string>(Object.values(suite.variants).map((variant) => variant.patch));
  for (const task of suite.tasks) for (const path of taskFilePaths(task)) paths.add(path);
  return hashCanonical({
    suite,
    files: [...paths].sort().map((path) => ({ path, sha256: digest(path, files) })),
  });
}

function digest(path: string, files: SuiteFiles): Sha256 {
  const content = files.get(path);
  if (content === undefined) throw new Error(`missing content for suite file "${path}"`);
  return sha256(content);
}
