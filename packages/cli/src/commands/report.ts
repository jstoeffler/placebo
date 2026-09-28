import { resolve, join } from 'node:path';
import {
  assembleResults,
  createSeededRandom,
  type Experiment,
  upfrontWarnings,
} from '@placebo-eval/core';
import { openStore, workspaceOf } from '../composition.js';
import { EXIT, UsageError } from '../errors.js';
import type { Host, Io } from '../host.js';
import { renderResults } from '../render/card.js';
import { colorsFor } from '../render/colors.js';
import { locateReportTemplate, writeArtifacts } from '../report-files.js';
import { ancestorWarnings, artifactLines, loadSuiteOrExplain, withWarnings } from './shared.js';

export interface ReportFlags {
  readonly suite?: string;
  readonly out?: string;
  readonly color: boolean;
}

/**
 * `placebo report [experiment id]`: rebuilds the results of an experiment, the newest by default,
 * from the run store (reviews included) and the suite, writes `results.json` and `report.html`,
 * and prints the cards again. Nothing runs and nothing is spent.
 */
export async function reportCommand(
  experimentId: string | undefined,
  flags: ReportFlags,
  io: Io,
  host: Host,
): Promise<number> {
  const workspace = await workspaceOf({
    cwd: host.cwd,
    env: host.env,
    home: host.home,
    ...(flags.suite === undefined ? {} : { suite: flags.suite }),
  });
  const loaded = await loadSuiteOrExplain(workspace);
  const templatePath = host.reportTemplate ?? locateReportTemplate();
  const store = await openStore(workspace);
  try {
    const experiments = await store.listExperiments();
    const experiment = pick(experiments, experimentId, workspace.storeDir);
    const [runs, reviews] = await Promise.all([
      store.list({ experimentId: experiment.id }),
      store.listReviews(),
    ]);
    const decoder = new TextDecoder();
    const upfront = upfrontWarnings({
      suite: loaded.suite,
      arms: experiment.arms,
      taskCount: experiment.taskIds.length,
      patchText: (patch) => {
        const bytes = loaded.files.get(patch);
        return bytes === undefined ? '' : decoder.decode(bytes);
      },
    });
    const results = withWarnings(
      assembleResults({
        experiment,
        runs,
        reviews,
        suite: loaded.suite,
        margins: loaded.suite.margins,
        random: createSeededRandom(experiment.seed),
        clock: host.clock,
        warnings: upfront,
      }),
      await ancestorWarnings(workspace, host),
    );
    const outDir =
      flags.out === undefined
        ? join(workspace.reportsDir, experiment.id)
        : resolve(host.cwd, flags.out);
    const artifacts = await writeArtifacts(outDir, results, templatePath);
    const colors = colorsFor(host.stdoutIsTTY, flags.color, host.env);
    io.stdout(
      `experiment ${experiment.id} · ${String(runs.length)} runs\n\n${renderResults(results, colors)}\n${artifactLines(artifacts, host.cwd)}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

/** The named experiment, or the newest; a usage error when there is none. */
function pick(
  experiments: readonly Experiment[],
  id: string | undefined,
  storeDir: string,
): Experiment {
  if (experiments.length === 0) {
    throw new UsageError(`the run store ${storeDir} has no experiment yet; run placebo run first`);
  }
  const found =
    id === undefined ? experiments[0] : experiments.find((experiment) => experiment.id === id);
  if (found === undefined) {
    throw new UsageError(
      `the run store has no experiment ${id ?? ''}; it has ${experiments.map((experiment) => experiment.id).join(', ')}`,
    );
  }
  return found;
}
