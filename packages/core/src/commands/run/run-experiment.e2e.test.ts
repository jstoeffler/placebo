// One core-level end-to-end run: the real local executor over a temporary git repo, the fake
// runner writing the fix, a command grader running a real hidden test with `sh`, and the
// in-memory store. Zero tokens.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunner } from '../../adapters/fake-runner/fake-runner.js';
import { LocalExecutor } from '../../adapters/local-executor/local-executor.js';
import { FileSuiteSource } from '../../adapters/local-suite/file-suite-source.js';
import { MemoryRunStore } from '../../adapters/memory-store/memory-run-store.js';
import { Results } from '../../domain/results.js';
import type { ProgressEvent } from '../../ports/reporter.js';
import { loadSuite } from '../load-suite.js';
import { runExperiment } from './run-experiment.js';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ada Author',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_COMMITTER_NAME: 'Cy Committer',
  GIT_COMMITTER_EMAIL: 'cy@example.com',
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

const BUGGY = 'export const refund = (amount) => Math.floor(amount * 100) / 100;\n';
const FIXED = 'export const refund = (amount) => Math.round(amount * 100) / 100;\n';
const PROMPT = 'Refunds round down. Fix the rounding in src/money.js.';

const RULES_PATCH = [
  'diff --git a/CLAUDE.md b/CLAUDE.md',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/CLAUDE.md',
  '@@ -0,0 +1 @@',
  '+Always run the tests.',
  '',
].join('\n');

let temp: string;
let repo: string;

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-e2e-')));
  repo = join(temp, 'repo');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  await put(repo, {
    'package.json': JSON.stringify(
      { name: 'tiny', private: true, scripts: { test: 'grep -q Math.round src/money.js' } },
      null,
      2,
    ),
    'src/money.js': BUGGY,
  });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'tiny project']);
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  // The suite stays untracked: it never enters a snapshot either way (ADR 0011).
  await put(join(repo, '.placebo'), {
    'suite.yaml': [
      `repo: ${repo}`,
      `commit: "${commit}"`,
      'model: claude-sonnet-5',
      'judge_model: claude-opus-5-5',
      'runs: 1',
      'parallelism: 2',
      'variants:',
      '  rules: { patch: variants/rules.patch }',
      'tasks:',
      '  - id: refund',
      `    prompt: "${PROMPT}"`,
      '    graders:',
      '      - { type: command, run: "sh hidden/refund.test.sh", hidden: [hidden/refund.test.sh] }',
      '      - { type: file_modified, path: src/money.js }',
      '',
    ].join('\n'),
    'variants/rules.patch': RULES_PATCH,
    // Passes only once the fix is in, and records that it ran.
    'tasks/refund/hidden/refund.test.sh':
      'echo ran > hidden-test-ran.txt\ngrep -q "Math.round" src/money.js && npm test --silent\n',
  });
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('runExperiment end to end', () => {
  it('runs a suite over a real repo with the local executor and a real hidden test', async () => {
    const loaded = await loadSuite(new FileSuiteSource(join(repo, '.placebo')));
    if (!loaded.ok) throw new Error(loaded.error.message);
    const clock = { now: () => new Date('2026-09-27T10:00:00.000Z') };
    const executor = new LocalExecutor({ root: join(temp, 'placebo-root'), clock });
    const hiddenPresentDuringRun: boolean[] = [];
    const runner = new FakeRunner({
      clock,
      plan: (request) => ({
        steps: [
          {
            wait: async () => {
              hiddenPresentDuringRun.push(
                await readFile(join(request.cwd, 'hidden/refund.test.sh')).then(
                  () => true,
                  () => false,
                ),
              );
            },
          },
          ...(FakeRunner.plans.editFile('src/money.js', FIXED).steps ?? []),
        ],
      }),
    });
    const store = new MemoryRunStore();
    const events: ProgressEvent[] = [];
    const result = await runExperiment({
      ...loaded.value,
      executor,
      runner,
      store,
      reporter: { report: (event) => events.push(event) },
      clock,
      seed: 1,
      placeboVersion: '0.0.0',
      resamples: 50,
    });
    if (!result.ok) throw new Error(result.error.message);
    const { experiment, results } = result.value;

    expect(Results.parse(results)).toEqual(results);
    expect(experiment.pins.commit).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    expect(hiddenPresentDuringRun).toEqual([false, false]);
    expect(results.runs).toHaveLength(2);
    for (const run of results.runs) {
      expect(run.outcome).toBe('completed');
      expect(run.change.files).toEqual(['src/money.js']);
      expect(run.change.diff).not.toContain('CLAUDE.md');
      const [command, modified] = run.grades;
      expect(command).toMatchObject({ passed: true, detail: { type: 'command', exitCode: 0 } });
      expect(modified?.passed).toBe(true);
      const folder = run.runFolder ?? '';
      await expect(readFile(join(folder, 'hidden-test-ran.txt'), 'utf8')).resolves.toBe('ran\n');
      const claudeMd = await readFile(join(folder, 'CLAUDE.md'), 'utf8').catch(() => undefined);
      expect(claudeMd).toBe(run.arm.kind === 'treatment' ? 'Always run the tests.\n' : undefined);
    }
    const passRate = results.verdictCards[0]?.rows.find((row) => row.metric === 'passRate');
    expect(passRate?.difference).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: 'experiment_finished', completedRuns: 2 });
  }, 180_000);
});
