import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Results } from '@placebo-eval/core/results';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { RESULTS_PLACEHOLDER } from '../report-files.js';
import { commitFiles, placebo, put, type Ran, tempRepo } from './test-support.js';

let temp: string;
let repo: string;
let home: string;
let template: string;
let commit: string;

function suiteYaml(overrides: { commit?: string; tasks?: string } = {}): string {
  return [
    `commit: "${overrides.commit ?? commit}"`,
    'model: claude-sonnet-5',
    'judge_model: claude-opus-5-5',
    'runs: 1',
    'parallelism: 2',
    'variants:',
    '  none: { patch: variants/none.patch }',
    'tasks:',
    overrides.tasks ??
      [
        '  - id: add-notes',
        '    prompt: Add a file named NOTES.md at the root.',
        '    graders:',
        '      - { type: file_exists, path: NOTES.md }',
      ].join('\n'),
    '',
  ].join('\n');
}

beforeEach(async () => {
  ({ temp, repo, home } = await tempRepo());
  commit = await commitFiles(repo, { 'CLAUDE.md': 'Keep it short.\n', 'README.md': '# tiny\n' });
  const patch = [
    'diff --git a/CLAUDE.md b/CLAUDE.md',
    'deleted file mode 100644',
    '--- a/CLAUDE.md',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-Keep it short.',
    '',
  ].join('\n');
  await put(join(repo, '.placebo'), {
    'suite.yaml': suiteYaml(),
    'variants/none.patch': patch,
  });
  template = join(temp, 'template.html');
  await writeFile(template, `<script type="application/json">${RESULTS_PLACEHOLDER}</script>`);
}, 30_000);

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function run(args: string[], host: Partial<Host> = {}): Promise<Ran> {
  return placebo(args, { repo, home }, { reportTemplate: template, ...host });
}

describe('placebo run', () => {
  it('runs the suite, prints the card and writes results and report', async () => {
    const ran = await run(['run', '--runner', 'fake', '--seed', '7', '--no-color']);
    expect(ran.stderr).toContain('seed 7');
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toMatch(/none vs control {12}1 run × 1 task {4}model claude-sonnet-5/);
    expect(ran.stdout).toMatch(/^ {2}pass rate {5}0 pts {5}\[0, 0\] {9}placebo$/m);
    const id = /experiment (\S+) · seed 7/.exec(ran.stderr)?.[1] ?? '';
    const out = join(repo, '.placebo', 'reports', id);
    expect(ran.stdout).toContain(
      `report: ${join('.placebo', 'reports', id, 'report.html')}\nresults: ${join('.placebo', 'reports', id, 'results.json')}\n`,
    );
    const results = Results.parse(JSON.parse(await readFile(join(out, 'results.json'), 'utf8')));
    expect(results.runs).toHaveLength(2);
    expect(results.runs.every((run) => run.runFolder?.startsWith(home) === true)).toBe(true);
    expect(await readFile(join(out, 'report.html'), 'utf8')).not.toContain(RESULTS_PLACEHOLDER);
    expect(existsSync(join(repo, '.placebo', 'runs', 'index.sqlite'))).toBe(true);
    expect(existsSync(join(repo, '.placebo', 'folders'))).toBe(false);
  }, 60_000);

  it('warns about configuration above the run folders and records it', async () => {
    await put(home, { 'CLAUDE.md': 'personal' });
    const ran = await run(['run', '--runner', 'fake', '--out', 'out', '--quiet', '--keep', 'none']);
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toContain(
      `warning: Claude Code loads configuration from above the run folders into every arm: ${join(home, 'CLAUDE.md')}`,
    );
    expect(ran.stderr).not.toContain('started');
    const results = Results.parse(
      JSON.parse(await readFile(join(repo, 'out', 'results.json'), 'utf8')),
    );
    expect(results.warnings).toContainEqual({
      type: 'ancestor_configuration',
      paths: [join(home, 'CLAUDE.md')],
    });
    expect(results.runs.every((run) => run.runFolder === undefined)).toBe(true);
  }, 60_000);

  it('exits 1 with the completed runs when the experiment ends early', async () => {
    await put(join(repo, '.placebo'), { 'suite.yaml': suiteYaml({ commit: 'ffffffffff' }) });
    const ran = await run(['run', '--runner', 'fake']);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toMatch(
      /error: the snapshot could not be prepared: .*\(0\/2 runs completed\)/,
    );
  }, 60_000);

  it('stops after runs in flight on Ctrl-C and exits at once on a second', async () => {
    const ran = await run(['run', '--runner', 'fake'], {
      onInterrupt: (handler) => {
        handler();
        handler();
        return () => undefined;
      },
    });
    expect(ran.stderr).toContain('stopping after runs in flight');
    expect(ran.exits).toEqual([130]);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain('aborted after 0 of 2 runs');
  }, 60_000);
});

describe('placebo run usage errors', () => {
  it('exits 2 when there is no suite', async () => {
    await rm(join(repo, '.placebo'), { recursive: true });
    const ran = await run(['run']);
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr).toContain('run placebo init to create one');
  });

  it("prints loadSuite's messages verbatim, one per line", async () => {
    await put(join(repo, '.placebo'), {
      'suite.yaml': suiteYaml({ tasks: '  - id: Bad\n    prompt: ""\n    graders: []' }),
    });
    const ran = await run(['run']);
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr.trimEnd().split('\n')).toEqual([
      expect.stringMatching(/^suite\.yaml:\d+ tasks\[0\]\.id: task id must be lowercase/),
      expect.stringMatching(/^suite\.yaml:\d+ tasks\[0\]\.prompt: prompt must not be empty$/),
      expect.stringMatching(
        /^suite\.yaml:\d+ tasks\[0\]\.graders: a task needs at least one grader$/,
      ),
    ]);
  });

  it('exits 2 for a task or variant the suite does not have', async () => {
    const ran = await run(['run', '--task', 'nope', '--variant', 'none']);
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr).toBe('the suite has no task "nope" (it has add-notes)\n');
  });

  it('exits 2 for a bad flag value', async () => {
    for (const args of [
      ['--runs', '0'],
      ['--parallelism', 'many'],
      ['--seed', '-1'],
      ['--seed', '4294967296'],
      ['--keep', 'some'],
      ['--runner', 'docker'],
      ['--unknown'],
    ]) {
      const ran = await run(['run', ...args]);
      expect(ran.exitCode, args.join(' ')).toBe(2);
    }
    expect((await run(['run', '--runner', 'docker'])).stderr).toContain('expected one of sdk, cli');
  });
});
