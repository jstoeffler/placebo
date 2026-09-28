import { randomInt } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  describeWarning,
  type KeepRunFolders,
  MAX_SEED,
  runExperiment,
  type TaskId,
  type VariantName,
} from '@placebo-eval/core';
import {
  createExecutor,
  createRunner,
  ObservedRunStore,
  openStore,
  resolveRepo,
  type RunnerKind,
  workspaceOf,
} from '../composition.js';
import { EXIT, UsageError } from '../errors.js';
import type { Host, Io } from '../host.js';
import { colorsFor } from '../render/colors.js';
import { renderResults } from '../render/card.js';
import { ProgressRenderer } from '../render/progress.js';
import { locateReportTemplate, writeArtifacts } from '../report-files.js';
import { VERSION } from '../version.js';
import { ancestorWarnings, artifactLines, loadSuiteOrExplain, withWarnings } from './shared.js';

export interface RunFlags {
  readonly suite?: string;
  readonly runs?: number;
  readonly parallelism?: number;
  readonly task?: readonly string[];
  readonly variant?: readonly string[];
  readonly keep?: KeepRunFolders;
  readonly seed?: number;
  readonly runner?: RunnerKind;
  readonly sandbox?: boolean;
  readonly out?: string;
  readonly color: boolean;
  readonly quiet?: boolean;
}

/**
 * `placebo run`: loads the suite, runs the experiment with progress on stderr, then prints the
 * verdict cards, the per-task table and the warnings on stdout and writes `results.json` and
 * `report.html`. Returns the exit code: 0 once the experiment completed, whatever the verdicts;
 * 1 when it ended early; usage problems throw `UsageError` before anything is spent.
 */
export async function runCommand(flags: RunFlags, io: Io, host: Host): Promise<number> {
  const workspace = await workspaceOf({
    cwd: host.cwd,
    env: host.env,
    home: host.home,
    ...(flags.suite === undefined ? {} : { suite: flags.suite }),
  });
  const loaded = await loadSuiteOrExplain(workspace);
  const suite = {
    ...loaded.suite,
    repo: resolveRepo(loaded.suite.repo, workspace.repoRoot),
    ...(flags.sandbox === undefined ? {} : { sandbox: flags.sandbox }),
  };
  checkSelection(
    'task',
    flags.task,
    suite.tasks.map((task) => task.id),
  );
  checkSelection('variant', flags.variant, Object.keys(suite.variants));
  const templatePath = host.reportTemplate ?? locateReportTemplate();

  const errColors = colorsFor(host.stderrIsTTY, flags.color, host.env);
  const outColors = colorsFor(host.stdoutIsTTY, flags.color, host.env);
  const seed = flags.seed ?? randomInt(0, MAX_SEED + 1);
  const progress = new ProgressRenderer({
    write: io.stderr,
    tty: host.stderrIsTTY,
    colors: errColors,
    seed,
    now: () => host.clock.now().getTime(),
    ...(host.columns === undefined ? {} : { columns: host.columns }),
    ...(flags.quiet === undefined ? {} : { quiet: flags.quiet }),
  });

  const extraWarnings = await ancestorWarnings(workspace, host);
  for (const warning of extraWarnings) {
    progress.report({
      type: 'message',
      level: 'warn',
      text: `${describeWarning(warning)}; move it, or set PLACEBO_HOME to a directory without it`,
    });
  }

  const store = await openStore(workspace);
  const controller = new AbortController();
  let interrupts = 0;
  const stopListening = host.onInterrupt(() => {
    interrupts += 1;
    if (interrupts === 1) {
      controller.abort(new Error('interrupted'));
      progress.report({
        type: 'message',
        level: 'info',
        text: 'stopping after runs in flight (Ctrl-C again to exit now)',
      });
    } else {
      progress.close();
      host.exit(130);
    }
  });
  try {
    const outcome = await runExperiment({
      suite,
      files: loaded.files,
      suiteHash: loaded.suiteHash,
      executor: createExecutor(workspace, host.clock),
      runner: createRunner(flags.runner ?? 'sdk', host.clock, host.env),
      store: new ObservedRunStore(store, (run) => {
        progress.recordRun(run);
      }),
      reporter: progress,
      clock: host.clock,
      seed,
      placeboVersion: VERSION,
      options: {
        signal: controller.signal,
        ...(flags.runs === undefined ? {} : { runs: flags.runs }),
        ...(flags.parallelism === undefined ? {} : { parallelism: flags.parallelism }),
        ...(flags.task === undefined ? {} : { tasks: flags.task as TaskId[] }),
        ...(flags.variant === undefined ? {} : { variants: flags.variant as VariantName[] }),
        ...(flags.keep === undefined ? {} : { keepRunFolders: flags.keep }),
      },
    });
    progress.close();
    if (!outcome.ok) {
      const error = outcome.error;
      io.stderr(
        `${errColors.red('error:')} ${error.message} (${String(error.completedRuns)}/${String(error.totalRuns)} runs completed)\n`,
      );
      if (error.experimentId !== undefined && error.completedRuns > 0) {
        io.stderr(
          `the completed runs are in the run store; placebo report ${error.experimentId} writes a report from them\n`,
        );
      }
      return EXIT.failed;
    }
    const results = withWarnings(outcome.value.results, extraWarnings);
    const outDir =
      flags.out === undefined
        ? join(workspace.reportsDir, results.experiment.id)
        : resolve(host.cwd, flags.out);
    const artifacts = await writeArtifacts(outDir, results, templatePath);
    io.stdout(`\n${renderResults(results, outColors)}\n${artifactLines(artifacts, host.cwd)}`);
    return EXIT.ok;
  } finally {
    stopListening();
    store.close();
  }
}

function checkSelection(
  what: string,
  selected: readonly string[] | undefined,
  known: readonly string[],
): void {
  const unknown = (selected ?? []).filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      unknown
        .map((name) => `the suite has no ${what} "${name}" (it has ${known.join(', ')})`)
        .join('\n'),
    );
  }
}
