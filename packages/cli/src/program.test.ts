import { describe, expect, it } from 'vitest';
import { main, NOT_IMPLEMENTED_EXIT_CODE } from './program.js';

async function run(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  await main(['node', 'placebo', ...args], {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  });
  return { stdout, stderr, exitCode };
}

describe('placebo', () => {
  it('prints the version from package.json', async () => {
    expect(await run('--version')).toMatchObject({ stdout: '0.0.0-test\n', exitCode: 0 });
  });

  it('lists the five v0.1 commands in help', async () => {
    const { stdout, exitCode } = await run('--help');
    for (const name of ['init', 'run', 'review', 'report', 'clean'])
      expect(stdout).toMatch(new RegExp(`^  ${name}\\b`, 'm'));
    expect(stdout).toContain('regenerate the HTML report from the run store');
    expect(exitCode).toBe(0);
  });

  it('documents the run flags and keeps the fake runner out of help', async () => {
    const { stdout } = await run('run', '--help');
    for (const flag of [
      '--suite <dir>',
      '--runs <n>',
      '--parallelism <n>',
      '--task <id>',
      '--variant <name>',
      '--keep <which>',
      '--seed <n>',
      '--runner <name>',
      '--sandbox',
      '--no-sandbox',
      '--out <dir>',
      '--no-color',
      '--quiet',
    ])
      expect(stdout).toContain(flag);
    expect(stdout).not.toContain('fake');
  });

  it.each(['review'])('stubs %s with exit code 2', async (name) => {
    const { stderr, exitCode } = await run(name);
    expect(stderr).toContain(`placebo ${name}: not implemented yet`);
    expect(exitCode).toBe(NOT_IMPLEMENTED_EXIT_CODE);
  });

  it('exits 2 on an unknown command', async () => {
    const { stderr, exitCode } = await run('compare');
    expect(stderr).toContain("unknown command 'compare'");
    expect(exitCode).toBe(2);
  });
});
