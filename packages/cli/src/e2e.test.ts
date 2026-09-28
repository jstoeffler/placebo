// The end-to-end run of brief §14: the program in-process on Placebo's own repo at HEAD, with
// the fake runner, the real local executor and the SQLite run store. Zero tokens.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Results } from '@placebo-eval/core/results';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placebo, put } from './commands/test-support.js';
import { RESULTS_PLACEHOLDER } from './report-files.js';

const here = fileURLToPath(new URL('.', import.meta.url));
// The checkout this file is in, a worktree or not; HEAD is read there, never from another one.
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: here,
  encoding: 'utf8',
}).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const claudeMd = execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd: repo, encoding: 'utf8' });

/** The built report when there is one; otherwise a stand-in with the same placeholder. */
const BUILT_REPORT = join(repo, 'packages', 'report', 'dist', 'report.html');

let temp: string;
let home: string;
let suite: string;
let template: string;

beforeAll(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-e2e-')));
  home = join(temp, 'home');
  suite = join(temp, 'suite');
  const lines = claudeMd.split('\n');
  if (lines.at(-1) === '') lines.pop();
  await put(suite, {
    'suite.yaml': [
      'repo: .',
      `commit: "${head}"`,
      'model: claude-sonnet-5',
      'judge_model: claude-opus-5-5',
      'variants:',
      '  none: { patch: variants/none.patch }',
      'tasks:',
      '  - id: describe-repo',
      '    prompt: Add a file named PLACEBO.md at the repository root that describes it.',
      '    graders:',
      '      - { type: file_exists, path: PLACEBO.md }',
      '',
    ].join('\n'),
    'variants/none.patch': [
      'diff --git a/CLAUDE.md b/CLAUDE.md',
      'deleted file mode 100644',
      '--- a/CLAUDE.md',
      '+++ /dev/null',
      `@@ -1,${String(lines.length)} +0,0 @@`,
      ...lines.map((line) => `-${line}`),
      '',
    ].join('\n'),
  });
  template = BUILT_REPORT;
  if (!existsSync(template)) {
    template = join(temp, 'report.html');
    await writeFile(template, `<script type="application/json">${RESULTS_PLACEHOLDER}</script>`);
  }
});

afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('placebo run on its own repo', () => {
  it('runs, prints the card, and writes a valid report outside the repo', async () => {
    const out = join(temp, 'out');
    const ran = await placebo(
      [
        'run',
        '--runner',
        'fake',
        '--suite',
        suite,
        '--runs',
        '2',
        '--parallelism',
        '2',
        '--seed',
        '7',
        '--out',
        out,
      ],
      { repo, home },
      { reportTemplate: template },
    );
    expect(ran.stderr).not.toContain('error');
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toMatch(/^ {2}pass rate {5}.*\b(helps|harms|placebo|no evidence)\b/m);

    const results = Results.parse(JSON.parse(await readFile(join(out, 'results.json'), 'utf8')));
    expect(results.experiment.pins.commit).toBe(head);
    expect(results.experiment.seed).toBe(7);
    expect(results.runs).toHaveLength(4);
    for (const run of results.runs) {
      expect(run.outcome).toBe('completed');
      expect(run.runFolder?.startsWith(`${home}/`)).toBe(true);
      expect(run.change.files).toEqual(['PLACEBO.md']);
    }

    const html = await readFile(join(out, 'report.html'), 'utf8');
    expect(html).not.toContain(RESULTS_PLACEHOLDER);
    expect(html).toContain(`"id":"${results.experiment.id}"`);

    expect(existsSync(join(repo, '.placebo', 'folders'))).toBe(false);
    expect(existsSync(join(repo, '.placebo', 'snapshots'))).toBe(false);
    expect(results.runs.some((run) => run.runFolder?.startsWith(`${repo}/`) === true)).toBe(false);
  }, 40_000);
});
