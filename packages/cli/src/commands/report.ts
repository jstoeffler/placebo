import { resolve, join } from 'node:path';
import { openStore, workspaceOf } from '../composition.js';
import { EXIT } from '../errors.js';
import type { Host, Io } from '../host.js';
import { renderResults } from '../render/card.js';
import { colorsFor } from '../render/colors.js';
import { locateReportTemplate, writeArtifacts } from '../report-files.js';
import { artifactLines, loadSuiteOrExplain, pickExperiment, rebuildResults } from './shared.js';

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
    const experiment = pickExperiment(experiments, experimentId, workspace.storeDir);
    const runs = await store.list({ experimentId: experiment.id });
    const results = await rebuildResults({
      workspace,
      loaded,
      experiment,
      runs,
      reviews: await store.listReviews(),
      host,
    });
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
