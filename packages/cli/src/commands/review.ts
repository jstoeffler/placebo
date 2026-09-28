import { readFile } from 'node:fs/promises';
import { createSeededRandom } from '@placebo-eval/core';
import { openStore, workspaceOf } from '../composition.js';
import { EXIT, UsageError } from '../errors.js';
import type { Host, Io } from '../host.js';
import { colorsFor } from '../render/colors.js';
import { locateReportTemplate } from '../report-files.js';
import { type ReviewServer, startReviewServer } from '../review-server/server.js';
import { loadSuiteOrExplain, pickExperiment, rebuildResults } from './shared.js';

export interface ReviewFlags {
  readonly suite?: string;
  readonly reviewer?: string;
  readonly port?: number;
  readonly open: boolean;
  readonly color: boolean;
}

/**
 * `placebo review [experiment id]`: serves the report of an experiment, the newest by default,
 * on localhost in blinded review mode, opens it in the browser unless `--no-open`, and keeps
 * serving until Ctrl-C. Reviews are saved to the run store as they are entered; `placebo report`
 * then includes them.
 */
export async function reviewCommand(
  experimentId: string | undefined,
  flags: ReviewFlags,
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
  const reviewer = flags.reviewer?.trim();
  if (reviewer === '') throw new UsageError('--reviewer needs a name');
  const store = await openStore(workspace);
  try {
    const experiment = pickExperiment(
      await store.listExperiments(),
      experimentId,
      workspace.storeDir,
    );
    const runs = await store.list({ experimentId: experiment.id });
    const results = await rebuildResults({
      workspace,
      loaded,
      experiment,
      runs,
      reviews: await store.listReviews(),
      host,
    });
    let server: ReviewServer;
    try {
      server = await startReviewServer({
        store,
        experiment,
        suite: loaded.suite,
        results,
        files: loaded.files,
        template: await readFile(templatePath, 'utf8'),
        ...(reviewer === undefined ? {} : { reviewer }),
        random: createSeededRandom(experiment.seed),
        clock: host.clock,
        ...(flags.port === undefined ? {} : { port: flags.port }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        throw new UsageError(
          `port ${String(flags.port)} is in use; pass another --port, or 0 for any free port`,
        );
      }
      throw error;
    }
    const colors = colorsFor(host.stdoutIsTTY, flags.color, host.env);
    io.stdout(
      `reviewing ${count(server.itemCount, 'run')} and ${count(server.comparisonCount, 'comparison')} of experiment ${experiment.id}\n` +
        `${colors.bold(server.url)}\n` +
        (server.itemCount + server.comparisonCount === 0
          ? 'no task of this experiment has checklist or review questions or a comparison grader, so there is nothing to review\n'
          : '') +
        'press Ctrl-C to stop\n',
    );
    if (flags.open) host.openUrl(server.url);
    await new Promise<void>((resolve) => {
      const stop = host.onInterrupt(() => {
        stop();
        resolve();
      });
    });
    await server.close();
    io.stdout(
      `\nsaved ${count(server.saved(), 'review')}\n` +
        `regenerate the report with them: placebo report ${experiment.id}${flags.suite === undefined ? '' : ` --suite ${flags.suite}`}\n`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}
