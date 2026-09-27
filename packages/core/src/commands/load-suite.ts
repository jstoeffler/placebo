import { formatSuiteIssues, parseSuite, type SuiteIssue } from '../domain/parse-suite.js';
import { hashSuite, hiddenFileSource } from '../domain/run-key.js';
import type { Suite } from '../domain/suite.js';
import type { Sha256 } from '../kernel/ids.js';
import { err, ok, type Result } from '../kernel/result.js';
import { SUITE_FILE, type SuiteSource } from '../ports/suite-source.js';

/** A parsed suite with the bytes of every file it references and its hash (an experiment pin). */
export interface LoadedSuite {
  readonly suite: Suite;
  /** Every variant patch and task file, as bytes, keyed by path relative to `.placebo/`. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly suiteHash: Sha256;
}

/** A file the suite references that cannot be used. */
export interface SuiteFileProblem {
  /** Relative to `.placebo/`. */
  readonly path: string;
  /** What refers to it, e.g. `patch of variant "none"`. */
  readonly referencedBy: string;
  readonly problem: 'missing' | 'outside_suite';
}

export type LoadSuiteError =
  | { readonly type: 'suite_missing'; readonly message: string }
  | {
      readonly type: 'invalid_suite';
      readonly issues: readonly SuiteIssue[];
      /** The issues, one per line, `suite.yaml:12 tasks[0].prompt: must not be empty`. */
      readonly message: string;
    }
  | {
      readonly type: 'missing_files';
      readonly files: readonly SuiteFileProblem[];
      /** One line per file, in suite order. */
      readonly message: string;
    };

/** A file the suite references, with what refers to it. */
interface Reference {
  readonly path: string;
  readonly referencedBy: string;
}

/**
 * Reads `suite.yaml`, parses it with `parseSuite`, then reads every file it references: each
 * variant patch, and per task the hidden files of its `command` graders (from
 * `tasks/<task id>/`), its checklist questions and its review questions. Every missing file is
 * reported at once, each with what refers to it. Read failures of files that exist are
 * infrastructure errors and reject.
 */
export async function loadSuite(source: SuiteSource): Promise<Result<LoadedSuite, LoadSuiteError>> {
  if (!(await source.exists(SUITE_FILE))) {
    return err({ type: 'suite_missing', message: `${SUITE_FILE} does not exist` });
  }
  const parsed = parseSuite(await source.readSuiteYaml());
  if (!parsed.ok) {
    return err({
      type: 'invalid_suite',
      issues: parsed.error,
      message: formatSuiteIssues(parsed.error, SUITE_FILE),
    });
  }
  const suite = parsed.value;

  const problems: SuiteFileProblem[] = [];
  const files = new Map<string, Uint8Array>();
  for (const reference of suiteReferences(suite)) {
    if (files.has(reference.path)) continue;
    const problem = !isInsideSuite(reference.path)
      ? 'outside_suite'
      : (await source.exists(reference.path))
        ? undefined
        : 'missing';
    if (problem !== undefined) {
      if (!problems.some((known) => known.path === reference.path)) {
        problems.push({ ...reference, problem });
      }
      continue;
    }
    files.set(reference.path, await source.readFile(reference.path));
  }
  if (problems.length > 0) {
    return err({
      type: 'missing_files',
      files: problems,
      message: problems.map(describeProblem).join('\n'),
    });
  }
  return ok({ suite, files, suiteHash: hashSuite(suite, files) });
}

/** Every file the suite references, in suite order: variants first, then tasks. */
function suiteReferences(suite: Suite): Reference[] {
  const references: Reference[] = Object.entries(suite.variants).map(([name, variant]) => ({
    path: variant.patch,
    referencedBy: `patch of variant "${name}"`,
  }));
  for (const [taskIndex, task] of suite.tasks.entries()) {
    const where = `task "${task.id}"`;
    for (const [index, grader] of task.graders.entries()) {
      const at = `tasks[${String(taskIndex)}].graders[${String(index)}]`;
      if (grader.type === 'command') {
        for (const hidden of grader.hidden ?? []) {
          references.push({
            path: hiddenFileSource(task.id, hidden),
            referencedBy: `hidden file of ${where}, ${at}`,
          });
        }
      } else if (grader.type === 'checklist') {
        references.push({
          path: grader.questions,
          referencedBy: `checklist questions of ${where}, ${at}`,
        });
      }
    }
    if (task.review) {
      references.push({
        path: task.review.questions,
        referencedBy: `review questions of ${where}, tasks[${String(taskIndex)}].review`,
      });
    }
  }
  return references;
}

/** A relative path that stays inside `.placebo/` once `.` and `..` segments are resolved. */
function isInsideSuite(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]/)) {
    if (segment === '..') depth -= 1;
    else if (segment !== '.' && segment !== '') depth += 1;
    if (depth < 0) return false;
  }
  return depth > 0;
}

function describeProblem(problem: SuiteFileProblem): string {
  const what =
    problem.problem === 'missing' ? 'does not exist' : 'is outside the suite folder .placebo/';
  return `${problem.path} ${what} (${problem.referencedBy})`;
}
