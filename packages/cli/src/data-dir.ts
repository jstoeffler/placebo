import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256 } from '@placebo-eval/core';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Where snapshots and run folders of a repo live (ADR 0014): outside the repo, so Claude Code
 * never loads the repo's own `CLAUDE.md` from an ancestor directory of a run folder.
 * `<PLACEBO_HOME or ~/.placebo>/<repo dir name>-<8 hex of sha256(repo path)>`.
 */
export function dataDirOf(repoRoot: string, env: Env, home: string = homedir()): string {
  const base =
    env.PLACEBO_HOME !== undefined && env.PLACEBO_HOME !== ''
      ? env.PLACEBO_HOME
      : join(home, '.placebo');
  const root = resolve(repoRoot);
  return join(resolve(base), `${basename(root)}-${sha256(root).slice(0, 8)}`);
}

/** The run folders under a data dir, as the local executor lays them out. */
export function foldersRootOf(dataDir: string): string {
  return join(dataDir, 'folders');
}

const MEMORY_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];

/**
 * Configuration Claude Code would load into every run from a directory above the run folders:
 * `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` and `.claude/` in the folders root and each of its
 * ancestors, nearest first. The user's own config directory is left out: it holds user settings,
 * which project-only settings keep out already.
 */
export async function ancestorConfiguration(
  foldersRoot: string,
  env: Env,
  home: string = homedir(),
): Promise<string[]> {
  const userConfig = new Set([
    resolve(home, '.claude'),
    ...(env.CLAUDE_CONFIG_DIR === undefined || env.CLAUDE_CONFIG_DIR === ''
      ? []
      : [resolve(env.CLAUDE_CONFIG_DIR)]),
  ]);
  const found: string[] = [];
  for (let dir = resolve(foldersRoot); ; dir = dirname(dir)) {
    for (const name of MEMORY_FILES) {
      if ((await stat(join(dir, name)).catch(() => undefined))?.isFile() === true) {
        found.push(join(dir, name));
      }
    }
    const claudeDir = join(dir, '.claude');
    if (
      !userConfig.has(claudeDir) &&
      (await stat(claudeDir).catch(() => undefined))?.isDirectory() === true
    ) {
      found.push(claudeDir);
    }
    if (dirname(dir) === dir) return found;
  }
}
