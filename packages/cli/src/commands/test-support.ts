// Shared by the command tests: temporary git repos and the program run in-process.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Host } from '../host.js';
import { main } from '../program.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

/** Runs git with a fixed identity and no user configuration. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

/** Writes files under `root`, creating directories. */
export async function put(root: string, files: Record<string, string | Uint8Array>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** A temporary directory with a `repo/` git repository (no commit yet) and a `home/`. */
export async function tempRepo(): Promise<{ temp: string; repo: string; home: string }> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-cmd-')));
  const repo = join(temp, 'repo');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  return { temp, repo, home: join(temp, 'home') };
}

/** Commits `files` in `repo` and returns the full commit id. */
export async function commitFiles(
  repo: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  await put(repo, files);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'files']);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

export interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  /** Codes passed to `host.exit`. */
  readonly exits: readonly number[];
}

/**
 * Runs `placebo <args>` in-process with a host rooted at `repo` and `home` (also
 * `PLACEBO_HOME`), not a terminal, and with no network for model lookups.
 */
export async function placebo(
  args: readonly string[],
  where: { readonly repo: string; readonly home: string },
  host: Partial<Host> = {},
): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  const exits: number[] = [];
  await main(
    ['node', 'placebo', ...args],
    {
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
      setExitCode: (code) => (exitCode = code),
    },
    {
      cwd: where.repo,
      env: { PLACEBO_HOME: where.home },
      home: where.home,
      stdoutIsTTY: false,
      stderrIsTTY: false,
      columns: undefined,
      onInterrupt: () => () => undefined,
      exit: (code) => exits.push(code),
      modelQuery: () => {
        throw new Error('no network in tests');
      },
      ...host,
    },
  );
  return { stdout, stderr, exitCode, exits };
}
