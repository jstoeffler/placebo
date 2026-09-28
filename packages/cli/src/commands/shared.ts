import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type LoadedSuite,
  loadSuite,
  type Results,
  SUITE_FILE,
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
