import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Results } from '@placebo-eval/core/results';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteRunStore } from '../adapters/sqlite-store/sqlite-run-store.js';
import { dataDirOf } from '../data-dir.js';
import { RESULTS_PLACEHOLDER } from '../report-files.js';
import { commitFiles, placebo, put, tempRepo } from './test-support.js';

let temp: string;
let repo: string;
let home: string;
let template: string;

const PATCH = [
  'diff --git a/CLAUDE.md b/CLAUDE.md',
  'deleted file mode 100644',
  '--- a/CLAUDE.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-Keep it short.',
  '',
].join('\n');

beforeEach(async () => {
  ({ temp, repo, home } = await tempRepo());
  const commit = await commitFiles(repo, { 'CLAUDE.md': 'Keep it short.\n', 'README.md': '# x\n' });
  await put(join(repo, '.placebo'), {
    'suite.yaml': [
      `commit: "${commit}"`,
      'model: claude-sonnet-5',
      'judge_model: claude-opus-5-5',
      'runs: 1',
      'variants:',
      '  none: { patch: variants/none.patch }',
      'tasks:',
      '  - id: add-notes',
      '    prompt: Add a file named NOTES.md.',
      '    graders:',
      '      - { type: file_exists, path: NOTES.md }',
      '',
    ].join('\n'),
    'variants/none.patch': PATCH,
  });
  template = join(temp, 'template.html');
  await writeFile(template, `<script>${RESULTS_PLACEHOLDER}</script>`);
}, 30_000);

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

const where = () => ({ repo, home });

async function runOnce(seed: string): Promise<string> {
  const ran = await placebo(['run', '--runner', 'fake', '--seed', seed, '--quiet'], where(), {
    reportTemplate: template,
  });
  expect(ran.exitCode).toBe(0);
  const id = /reports\/([^/]+)\/report\.html/.exec(ran.stdout)?.[1];
  if (id === undefined) throw new Error(`no experiment id in ${ran.stdout}`);
  return id;
}

function folders(): Promise<string[]> {
  return readdir(join(dataDirOf(repo, { PLACEBO_HOME: home }, home), 'folders')).then(
    (names) => names.filter((name) => !name.endsWith('.json')),
    () => [],
  );
}

describe('placebo report', () => {
  it('rebuilds the newest experiment from the run store, reviews included', async () => {
    const first = await runOnce('1');
    const newest = await runOnce('2');
    const store = await new SqliteRunStore(join(repo, '.placebo', 'runs')).open();
    const [run] = await store.list({ experimentId: newest as never });
    if (run === undefined) throw new Error('no run');
    await store.saveReview({
      id: 'rev-1' as never,
      runId: run.id,
      reviewer: 'ada',
      createdAt: new Date().toISOString(),
      answer: { type: 'checklist', answers: [{ question: 'Is it there?', yes: true }] },
    });
    store.close();

    const ran = await placebo(['report', '--out', 'rebuilt'], where(), {
      reportTemplate: template,
    });
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain(`experiment ${newest} · 2 runs`);
    expect(ran.stdout).toMatch(/^none vs control {12}1 run × 1 task/m);
    expect(ran.stdout).toContain('report: rebuilt/report.html\nresults: rebuilt/results.json\n');
    const results = Results.parse(
      JSON.parse(await readFile(join(repo, 'rebuilt', 'results.json'), 'utf8')),
    );
    expect(results.experiment.id).toBe(newest);
    expect(results.reviews.map((review) => review.id)).toEqual(['rev-1']);
    expect(await readFile(join(repo, 'rebuilt', 'report.html'), 'utf8')).not.toContain(
      RESULTS_PLACEHOLDER,
    );

    const older = await placebo(['report', first], where(), { reportTemplate: template });
    expect(older.exitCode).toBe(0);
    expect(existsSync(join(repo, '.placebo', 'reports', first, 'results.json'))).toBe(true);
  }, 90_000);

  it('exits 2 when the run store is empty or has no such experiment', async () => {
    const empty = await placebo(['report'], where(), { reportTemplate: template });
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain('has no experiment yet; run placebo run first');
    await runOnce('3');
    const unknown = await placebo(['report', 'nope'], where(), { reportTemplate: template });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('the run store has no experiment nope; it has ');
  }, 60_000);
});

describe('placebo clean', () => {
  it('lists with --dry-run, then removes run folders and forgets them in the store', async () => {
    const id = await runOnce('4');
    expect(await folders()).toHaveLength(2);

    const dry = await placebo(['clean', '--dry-run'], where());
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toMatch(/would remove 2 run folders, \d+(\.\d)? (B|KB|MB)\n$/);
    expect(await folders()).toHaveLength(2);

    const ran = await placebo(['clean', '--snapshots'], where());
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toMatch(/^removed 2 run folders and 1 snapshot, /);
    expect(ran.stdout).toContain('2 stored runs no longer point at a run folder');
    expect(await folders()).toHaveLength(0);
    const store = await new SqliteRunStore(join(repo, '.placebo', 'runs')).open();
    const runs = await store.list({ experimentId: id as never });
    store.close();
    expect(runs.map((run) => run.runFolder)).toEqual([undefined, undefined]);

    const again = await placebo(['clean'], where());
    expect(again.stdout).toBe('removed 0 run folders, 0 B\n');
  }, 60_000);

  it("limits to one experiment's run folders and snapshots", async () => {
    const first = await runOnce('5');
    await runOnce('6');
    expect(await folders()).toHaveLength(4);
    const ran = await placebo(['clean', '--experiment', first, '--snapshots'], where());
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toMatch(/^removed 2 run folders and 1 snapshot, /);
    expect(await folders()).toHaveLength(2);

    const unknown = await placebo(['clean', '--experiment', 'nope'], where());
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('the run store has no experiment nope');
  }, 90_000);
});
