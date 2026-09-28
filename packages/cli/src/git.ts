import { execFile } from 'node:child_process';
import { UsageError } from './errors.js';

interface GitOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs git with the user's configuration neutralised where it changes output: no pager, no
 * colour, standard diff prefixes. Never rejects; the exit code is in the result.
 */
function git(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<GitOutput> {
  const settings = ['color.ui=false', 'diff.noprefix=false', 'diff.mnemonicPrefix=false'];
  return new Promise((resolve) => {
    execFile(
      'git',
      [...settings.flatMap((setting) => ['-c', setting]), ...args],
      { cwd, env: { ...env, GIT_PAGER: 'cat' }, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** The top level of the git repository containing `cwd`. */
export async function repoRootOf(cwd: string): Promise<string> {
  const out = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (out.code !== 0) {
    throw new UsageError(`${cwd} is not inside a git repository; run placebo from your repo`);
  }
  return out.stdout.trim();
}
