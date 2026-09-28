import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { git } from '../git.js';

const MEMORY_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);

/**
 * Whether `none.patch` deletes a tracked file: `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` at
 * any depth, anything under a `.claude/` directory at any depth, and `.mcp.json` at the root.
 */
export function isClaudeConfiguration(path: string): boolean {
  return (
    MEMORY_FILES.has(basename(path)) || path.split('/').includes('.claude') || path === '.mcp.json'
  );
}

/** Paths per `git update-index` call, well under any argument-length limit. */
const BATCH = 200;

/**
 * The variant patch that deletes every Claude Code configuration file tracked at `commit`, built
 * with git itself so `git apply` accepts it: a scratch index starts as the commit's tree, loses
 * those files, and is diffed against the commit. Binary files and symbolic links come out as
 * deletions `git apply` understands. Undefined when the commit tracks no such file.
 */
export async function nonePatch(
  repoRoot: string,
  commit: string,
): Promise<{ readonly patch: string; readonly paths: readonly string[] } | undefined> {
  const listed = await git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', commit]);
  if (listed.code !== 0) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`);
  const paths = listed.stdout
    .split('\0')
    .filter((path) => path !== '' && isClaudeConfiguration(path));
  if (paths.length === 0) return undefined;

  const scratch = await mkdtemp(join(tmpdir(), 'placebo-none-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    const step = async (args: string[]): Promise<string> => {
      const out = await git(repoRoot, args, env);
      if (out.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${out.stderr.trim()}`);
      return out.stdout;
    };
    await step(['read-tree', commit]);
    for (let start = 0; start < paths.length; start += BATCH) {
      await step(['update-index', '--force-remove', '--', ...paths.slice(start, start + BATCH)]);
    }
    const patch = await step([
      'diff',
      '--cached',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--no-relative',
      commit,
    ]);
    return { patch, paths };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
