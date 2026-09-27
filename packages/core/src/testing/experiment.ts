// Test support for the run command: a two-task suite, its files, and a harness wiring
// runExperiment to the fake runner, the fake executor (real temporary run folders) and the
// in-memory store. Spends zero tokens.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FakeExecutor, type FakeExecutorOptions } from '../adapters/fake-executor/fake-executor.js';
import { FakeRunner, type FakePlan } from '../adapters/fake-runner/fake-runner.js';
import { MemoryRunStore } from '../adapters/memory-store/memory-run-store.js';
import type { RunExperimentInput, RunExperimentOptions } from '../commands/run/run-experiment.js';
import type { Change } from '../domain/change.js';
import { CHECKLIST_JUDGE_OUTPUT_SCHEMA } from '../domain/grade.js';
import { hashSuite, type SuiteFiles } from '../domain/run-key.js';
import { Suite, type SuiteInput } from '../domain/suite.js';
import type { Clock } from '../kernel/clock.js';
import type { ProgressEvent } from '../ports/reporter.js';
import type { RunRequest } from '../ports/runner.js';

export const REFUND_PROMPT = 'Fix the refund rounding.';
export const GREETING_PROMPT = 'Add a greeting.';

export const RULES_PATCH = [
  'diff --git a/CLAUDE.md b/CLAUDE.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/CLAUDE.md',
  '@@ -0,0 +1 @@',
  '+Always run the tests.',
  '',
].join('\n');

/**
 * Two tasks. `refund` has a command grader with a hidden file, `file_modified`, a checklist and a
 * comparison; `greeting` has a command and `file_modified` only. One treatment, `rules`.
 */
const experimentSuiteInput: SuiteInput = {
  commit: '3f9a1c2e',
  model: 'claude-sonnet-5',
  judgeModel: 'claude-opus-5-5',
  runs: 2,
  parallelism: 2,
  variants: { rules: { patch: 'variants/rules.patch' } },
  tasks: [
    {
      id: 'refund',
      prompt: REFUND_PROMPT,
      graders: [
        { type: 'command', run: 'sh check.sh', hidden: ['check.sh'] },
        { type: 'file_modified', path: 'src/money.ts' },
        { type: 'checklist', questions: 'tasks/refund/checklist.md' },
        { type: 'comparison' },
      ],
    },
    {
      id: 'greeting',
      prompt: GREETING_PROMPT,
      graders: [
        { type: 'command', run: 'test -f hello.txt' },
        { type: 'file_modified', path: 'hello.txt' },
      ],
    },
  ],
};

const encoder = new TextEncoder();

function experimentFiles(overrides: Record<string, string> = {}): SuiteFiles {
  const files: Record<string, string> = {
    'variants/rules.patch': RULES_PATCH,
    'tasks/refund/check.sh': 'grep -q round src/money.ts\n',
    'tasks/refund/checklist.md': '- Rounds half up?\n- Keeps the signature?\n',
    ...overrides,
  };
  return new Map(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]));
}

/** The subject edits a file per task; judges answer yes to both checklist questions and prefer `a`. */
export function defaultPlan(request: RunRequest): FakePlan {
  if (request.outputSchema === CHECKLIST_JUDGE_OUTPUT_SCHEMA) {
    return FakeRunner.plans.judgeAnswer({
      answers: [
        { question: 'Rounds half up?', yes: true, reason: 'It does.' },
        { question: 'Keeps the signature?', yes: true, reason: 'It does.' },
      ],
    });
  }
  if (request.outputSchema !== undefined) {
    return FakeRunner.plans.judgeAnswer({ better: 'a', reason: 'Clearer.' });
  }
  return request.prompt === REFUND_PROMPT
    ? FakeRunner.plans.editFile('src/money.ts', 'export const round = Math.round;\n')
    : FakeRunner.plans.editFile('hello.txt', 'hello\n');
}

/** A change listing every file under the run folder, as a real executor would after an edit. */
function changeOfFolder(folder: { readonly path: string }): Change {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(relative(folder.path, path));
    }
  };
  walk(folder.path);
  files.sort();
  const diff = files
    .map((file) => `+++ b/${file}\n${readFileSync(join(folder.path, file), 'utf8')}`)
    .join('');
  return { diff, files, bytes: encoder.encode(diff).length };
}

const experimentClock: Clock = { now: () => new Date('2026-09-27T10:00:00.000Z') };

export interface HarnessOptions {
  readonly suite?: Partial<SuiteInput>;
  readonly files?: Record<string, string>;
  readonly plan?: (request: RunRequest) => FakePlan;
  readonly executor?: FakeExecutorOptions;
  readonly options?: RunExperimentOptions;
  readonly seed?: number;
  readonly store?: MemoryRunStore;
}

export interface Harness {
  readonly input: RunExperimentInput;
  readonly runner: FakeRunner;
  readonly executor: FakeExecutor;
  readonly store: MemoryRunStore;
  readonly events: ProgressEvent[];
  /** Every wait the command asked for, in ms. */
  readonly sleeps: number[];
}

/** A `RunExperimentInput` over fakes; remember `executor.cleanup()` in `afterEach`. */
export function harness(options: HarnessOptions = {}): Harness {
  const suite = Suite.parse({ ...experimentSuiteInput, ...options.suite });
  const files = experimentFiles(options.files);
  const runner = new FakeRunner({ clock: experimentClock, plan: options.plan ?? defaultPlan });
  const executor = new FakeExecutor({
    realDirs: true,
    change: changeOfFolder,
    ...options.executor,
  });
  const store = options.store ?? new MemoryRunStore();
  const events: ProgressEvent[] = [];
  const sleeps: number[] = [];
  return {
    input: {
      suite,
      files,
      suiteHash: hashSuite(suite, files),
      executor,
      runner,
      store,
      reporter: { report: (event) => events.push(event) },
      clock: experimentClock,
      seed: options.seed ?? 42,
      placeboVersion: '0.0.0',
      options: { ...options.options },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      resamples: 50,
    },
    runner,
    executor,
    store,
    events,
    sleeps,
  };
}
