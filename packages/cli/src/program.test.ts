import { describe, expect, it } from 'vitest';
import { createProgram, NOT_IMPLEMENTED_EXIT_CODE } from './program.js';

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number | undefined } {
  let stdout = '';
  let stderr = '';
  let exitCode: number | undefined;
  const program = createProgram({
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    setExitCode: (code) => (exitCode = code),
  }).exitOverride();
  try {
    program.parse(['node', 'placebo', ...args]);
  } catch (error) {
    exitCode = (error as { exitCode: number }).exitCode;
  }
  return { stdout, stderr, exitCode };
}

describe('placebo', () => {
  it('prints the version from package.json', () => {
    expect(run('--version')).toMatchObject({ stdout: '0.0.0-test\n', exitCode: 0 });
  });

  it('lists the five v0.1 commands in help', () => {
    const { stdout } = run('--help');
    for (const name of ['init', 'run', 'review', 'report', 'clean'])
      expect(stdout).toMatch(new RegExp(`^  ${name} `, 'm'));
    expect(stdout).toContain('regenerate the HTML report from the run store');
  });

  it.each(['init', 'run', 'review', 'report', 'clean'])('stubs %s with exit code 2', (name) => {
    const { stderr, exitCode } = run(name);
    expect(stderr).toContain(`placebo ${name}: not implemented yet`);
    expect(exitCode).toBe(NOT_IMPLEMENTED_EXIT_CODE);
  });

  it('rejects unknown commands', () => {
    expect(run('compare').exitCode).toBe(1);
  });
});
