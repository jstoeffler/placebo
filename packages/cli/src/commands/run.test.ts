import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Results } from '@placebo-eval/core/results';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { main } from '../program.js';
import { RESULTS_PLACEHOLDER } from '../report-files.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

async function put(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

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
  temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-run-')));
  repo = join(temp, 'repo');
  home = join(temp, 'home');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  await put(repo, { 'CLAUDE.md': 'Keep it short.\n', 'README.md': '# tiny\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'tiny']);
  commit = git(repo, ['rev-parse', 'HEAD']).trim();
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

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
  readonly exits: number[];
}

async function placebo(args: string[], host: Partial<Host> = {}): Promise<Ran> {
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
      cwd: repo,
      env: { PLACEBO_HOME: home },
      home,
      stdoutIsTTY: false,
      stderrIsTTY: false,
      columns: undefined,
      onInterrupt: () => () => undefined,
      exit: (code) => exits.push(code),
      reportTemplate: template,
      ...host,
    },
  );
  return { stdout, stderr, exitCode, exits };
}

describe('placebo run', () => {
  it('runs the suite, prints the card and writes results and report', async () => {
    const ran = await placebo(['run', '--runner', 'fake', '--seed', '7', '--no-color']);
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
    const ran = await placebo([
      'run',
      '--runner',
      'fake',
      '--out',
      'out',
      '--quiet',
      '--keep',
      'none',
    ]);
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
    const ran = await placebo(['run', '--runner', 'fake']);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toMatch(
      /error: the snapshot could not be prepared: .*\(0\/2 runs completed\)/,
    );
  }, 60_000);

  it('stops after runs in flight on Ctrl-C and exits at once on a second', async () => {
    const ran = await placebo(['run', '--runner', 'fake'], {
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
    const ran = await placebo(['run']);
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr).toContain('run placebo init to create one');
  });

  it("prints loadSuite's messages verbatim, one per line", async () => {
    await put(join(repo, '.placebo'), {
      'suite.yaml': suiteYaml({ tasks: '  - id: Bad\n    prompt: ""\n    graders: []' }),
    });
    const ran = await placebo(['run']);
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
    const ran = await placebo(['run', '--task', 'nope', '--variant', 'none']);
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
      const ran = await placebo(['run', ...args]);
      expect(ran.exitCode, args.join(' ')).toBe(2);
    }
    expect((await placebo(['run', '--runner', 'docker'])).stderr).toContain(
      'expected one of sdk, cli',
    );
  });
});
