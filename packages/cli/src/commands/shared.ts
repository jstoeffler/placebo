import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  agreementOf,
  assembleResults,
  createSeededRandom,
  type Experiment,
  type LoadedSuite,
  loadSuite,
  type Results,
  type Review,
  type Run,
  SUITE_FILE,
  upfrontWarnings,
  type Warning,
} from '@placebo-eval/core';
import { Results as ResultsSchema } from '@placebo-eval/core/results';
import { createSuiteSource, type Workspace } from '../composition.js';
import { ancestorConfiguration, foldersRootOf } from '../data-dir.js';
import { UsageError } from '../errors.js';
import type { Host } from '../host.js';
import type { Artifacts } from '../report-files.js';

/** Loads the suite, turning every problem into a usage error that lists them one per line. */
export async function loadSuiteOrExplain(workspace: Workspace): Promise<LoadedSuite> {
  if (!existsSync(join(workspace.suiteDir, SUITE_FILE))) {
    throw new UsageError(
      `no suite at ${join(workspace.suiteDir, SUITE_FILE)}; run placebo init to create one, or pass --suite <dir>`,
    );
  }
  const loaded = await loadSuite(createSuiteSource(workspace));
  if (!loaded.ok) throw new UsageError(loaded.error.message);
  return loaded.value;
}

/** The results with warnings the cli found, each once, validated again. */
export function withWarnings(results: Results, extra: readonly Warning[]): Results {
  const seen = new Set(results.warnings.map((warning) => JSON.stringify(warning)));
  const added = extra.filter((warning) => !seen.has(JSON.stringify(warning)));
  if (added.length === 0) return results;
  return ResultsSchema.parse({ ...results, warnings: [...results.warnings, ...added] });
}

/** The results with the agreement of their reviews, when they have any, validated again. */
export function withAgreement(results: Results): Results {
  const agreement = agreementOf(results.runs, results.reviews);
  if (agreement === undefined) return results;
  return ResultsSchema.parse({ ...results, agreement });
}

/** `report: …` and `results: …`, relative to the current directory when inside it. */
export function artifactLines(artifacts: Artifacts, cwd: string): string {
  const shown = (path: string): string => {
    const rel = relative(cwd, path);
    return rel.startsWith('..') || rel === '' ? path : rel;
  };
  return `report: ${shown(artifacts.report)}\nresults: ${shown(artifacts.results)}\n`;
}

/** The `ancestor_configuration` warning for the workspace's run folders, if any (ADR 0014). */
export async function ancestorWarnings(workspace: Workspace, host: Host): Promise<Warning[]> {
  const paths = await ancestorConfiguration(foldersRootOf(workspace.dataDir), host.env, host.home);
  return paths.length === 0 ? [] : [{ type: 'ancestor_configuration', paths }];
}

/** The named experiment, or the newest; a usage error when there is none. */
export function pickExperiment(
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

/**
 * The results of an experiment rebuilt from its runs and reviews, with the suite's upfront
 * warnings, the workspace's ancestor configuration warning and the reviews' agreement.
 */
export async function rebuildResults(input: {
  readonly workspace: Workspace;
  readonly loaded: LoadedSuite;
  readonly experiment: Experiment;
  readonly runs: readonly Run[];
  readonly reviews: readonly Review[];
  readonly host: Host;
}): Promise<Results> {
  const { experiment, loaded } = input;
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
  return withAgreement(
    withWarnings(
      assembleResults({
        experiment,
        runs: input.runs,
        reviews: input.reviews,
        suite: loaded.suite,
        margins: loaded.suite.margins,
        random: createSeededRandom(experiment.seed),
        clock: input.host.clock,
        warnings: upfront,
      }),
      await ancestorWarnings(input.workspace, input.host),
    ),
  );
}
