import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { formatCurrency } from '@placebo-eval/core';
import {
  ModelResolutionError,
  resolveModel,
  type ResolvedModel,
} from '../adapters/model-resolver.js';
import { EXIT, UsageError } from '../errors.js';
import { git, repoRootOf } from '../git.js';
import type { Host, Io } from '../host.js';
import { nonePatch } from '../init/none-patch.js';
import { detectSetup } from '../init/setup-command.js';
import {
  EXAMPLE_CHECKLIST,
  EXAMPLE_TASK,
  SUITE_GITIGNORE,
  suiteYaml,
} from '../init/suite-template.js';

export interface InitFlags {
  readonly force?: boolean;
  readonly model?: string;
  readonly judgeModel?: string;
}

const NONE_PATCH = 'variants/none.patch';

/**
 * `placebo init`: creates `.placebo/` at the repo root with the commit at `HEAD`, the subject and
 * judge models as full IDs, the setup command of the repo's lockfile, `variants/none.patch` and
 * one example task. Models not given as flags are asked of Claude Code itself; with both flags
 * nothing goes over the network.
 */
export async function initCommand(flags: InitFlags, io: Io, host: Host): Promise<number> {
  const repoRoot = await repoRootOf(host.cwd);
  const suiteDir = join(repoRoot, '.placebo');
  if (existsSync(suiteDir) && flags.force !== true) {
    throw new UsageError(`${suiteDir} already exists; pass --force to write the suite over it`);
  }
  const head = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code !== 0) {
    throw new UsageError(`${repoRoot} has no commit yet; commit first, then run placebo init`);
  }
  const commit = head.stdout.trim();

  const say = (text: string): void => {
    io.stdout(`${text}\n`);
  };
  const models = await pinModels(flags, repoRoot, host, io);
  if (models === undefined) {
    io.stderr(
      'pass --model <id> and --judge-model <id> to write the suite without asking Claude Code\n',
    );
    return EXIT.failed;
  }

  const setup = detectSetup(repoRoot);
  const none = await nonePatch(repoRoot, commit);
  const files: [string, string][] = [
    [
      'suite.yaml',
      suiteYaml({
        commit,
        ...models,
        ...(setup === undefined ? {} : { setup: setup.command }),
        ...(none === undefined ? {} : { nonePatch: NONE_PATCH }),
      }),
    ],
    [EXAMPLE_TASK.checklist, EXAMPLE_CHECKLIST],
    ['.gitignore', SUITE_GITIGNORE],
  ];
  if (none !== undefined) files.push([NONE_PATCH, none.patch]);
  for (const [path, content] of files) {
    await mkdir(dirname(join(suiteDir, path)), { recursive: true });
    await writeFile(join(suiteDir, path), content);
  }

  const rows: [string, string][] = [
    ['suite.yaml', `commit ${commit}`],
    ['', `model ${models.model}, judge ${models.judgeModel}`],
    [
      '',
      setup === undefined
        ? 'no setup command (no lockfile found)'
        : `setup \`${setup.command}\` (from ${setup.lockfile})`,
    ],
    none === undefined
      ? [`no ${NONE_PATCH}`, 'the repo has no Claude Code configuration to strip;']
      : [
          NONE_PATCH,
          `deletes ${String(none.paths.length)} ${none.paths.length === 1 ? 'file' : 'files'}: ${summarize(none.paths)}`,
        ],
    ...(none === undefined
      ? [['', 'declare a variant in suite.yaml before placebo run'] as [string, string]]
      : []),
    [EXAMPLE_TASK.checklist, `questions of the example task ${EXAMPLE_TASK.id}`],
    ['.gitignore', 'keeps runs/ and reports/ out of git'],
  ];
  const width = Math.max(...rows.map(([path]) => path.length)) + 2;
  say(`wrote .placebo/ in ${repoRoot}`);
  for (const [path, text] of rows) say(`  ${path.padEnd(width)}${text}`);
  const dirty = await git(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
  if (dirty.stdout.trim() !== '') {
    say('note: uncommitted changes are not part of the experiment; it runs the commit above');
  }
  say('');
  say('next:');
  say('  placebo run --runs 1    a first pass, one run per task per arm, to check the suite');
  say('  placebo run             the experiment, 5 runs per task per arm');
  return EXIT.ok;
}

interface PinnedModels {
  readonly model: string;
  readonly modelNote: string;
  readonly judgeModel: string;
  readonly judgeNote: string;
}

async function pinModels(
  flags: InitFlags,
  repoRoot: string,
  host: Host,
  io: Io,
): Promise<PinnedModels | undefined> {
  // An object, not `let`s: `ask` mutates it, which flow analysis cannot see.
  const spend = { usd: 0, known: false };
  const ask = async (alias: string | undefined): Promise<ResolvedModel> => {
    const resolved = await resolveModel({
      cwd: repoRoot,
      env: host.env,
      ...(alias === undefined ? {} : { alias }),
      ...(host.modelQuery === undefined ? {} : { query: host.modelQuery }),
    });
    if (resolved.costUsd !== undefined) {
      spend.usd += resolved.costUsd;
      spend.known = true;
    }
    return resolved;
  };
  try {
    const model = flags.model ?? (await ask(undefined)).model;
    const modelNote =
      flags.model === undefined ? 'written by init from your current default' : 'from --model';
    let judgeModel = flags.judgeModel;
    let judgeNote = 'from --judge-model';
    if (judgeModel === undefined) {
      judgeModel = (await ask('opus')).model;
      judgeNote = 'written by init from the current Opus';
      if (judgeModel === model) {
        io.stdout(
          `the current Opus is also the subject model (${model}); a model judging its own work favours it, so the judge is the current Sonnet\n`,
        );
        judgeModel = (await ask('sonnet')).model;
        judgeNote = 'written by init from the current Sonnet';
      }
    } else if (judgeModel === model) {
      io.stderr(
        `warning: the judge model is the subject model (${model}); a model judging its own work favours it\n`,
      );
    }
    if (spend.known) {
      io.stdout(`asking Claude Code for the model IDs cost ${formatCurrency(spend.usd)}\n`);
    }
    return { model, modelNote, judgeModel, judgeNote };
  } catch (error) {
    if (!(error instanceof ModelResolutionError)) throw error;
    io.stderr(`error: could not ask Claude Code for the model IDs: ${error.message}\n`);
    return undefined;
  }
}

/** Up to three paths, then how many more. */
function summarize(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${String(paths.length - 3)} more` : shown;
}
