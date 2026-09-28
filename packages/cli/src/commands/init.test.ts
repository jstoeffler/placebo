import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FileSuiteSource, loadSuite, parseSuite } from '@placebo-eval/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFunction } from '../adapters/sdk-runner/sdk-runner.js';
import type { Host } from '../host.js';
import { RESULTS_PLACEHOLDER } from '../report-files.js';
import { commitFiles, placebo, put, type Ran, tempRepo } from './test-support.js';

let temp: string;
let repo: string;
let commit: string;

let home: string;

async function makeRepo(files: Record<string, string>): Promise<void> {
  commit = await commitFiles(repo, files);
}

beforeEach(async () => {
  ({ temp, repo, home } = await tempRepo());
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

function run(args: string[], host: Partial<Host> = {}): Promise<Ran> {
  return placebo(args, { repo, home }, host);
}

const PINNED = ['init', '--model', 'claude-sonnet-5', '--judge-model', 'claude-opus-5-5'];

describe('placebo init', () => {
  it('writes a suite loadSuite accepts, in the shape of the brief', async () => {
    await makeRepo({
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': '# Rules\n',
      '.claude/settings.json': '{}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'README.md': '# shop\n',
    });
    const ran = await run(PINNED);
    expect(ran.exitCode).toBe(0);
    const suiteDir = join(repo, '.placebo');
    const yaml = await readFile(join(suiteDir, 'suite.yaml'), 'utf8');
    expect(yaml).toBe(
      [
        '# .placebo/suite.yaml',
        'repo: .',
        `commit: "${commit}"`,
        'model: claude-sonnet-5            # from --model',
        'judge_model: claude-opus-5-5      # from --judge-model',
        'runs: 5',
        'parallelism: 4',
        'setup: pnpm install --frozen-lockfile',
        '',
        'variants:',
        '  none:   { patch: variants/none.patch }',
        '',
        'tasks:',
        '  - id: describe-repo',
        '    prompt: |',
        '      Add a file named PLACEBO.md at the repository root containing one paragraph that describes what this repository does and how to run its tests. Do not change anything else.',
        '    graders:',
        '      - { type: file_exists, path: PLACEBO.md }',
        '      - { type: checklist, questions: tasks/describe-repo/checklist.md }',
        '      - { type: comparison }',
        '    review:',
        '      questions: tasks/describe-repo/checklist.md',
        '',
      ].join('\n'),
    );
    const parsed = parseSuite(yaml);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value).toMatchObject({
      repo: '.',
      commit,
      model: 'claude-sonnet-5',
      judgeModel: 'claude-opus-5-5',
      runs: 5,
      parallelism: 4,
      setup: 'pnpm install --frozen-lockfile',
      sandbox: true,
      variants: { none: { patch: 'variants/none.patch' } },
      tasks: [
        {
          id: 'describe-repo',
          prompt:
            'Add a file named PLACEBO.md at the repository root containing one paragraph that describes what this repository does and how to run its tests. Do not change anything else.\n',
          graders: [
            { type: 'file_exists', path: 'PLACEBO.md' },
            {
              type: 'checklist',
              questions: 'tasks/describe-repo/checklist.md',
              agentic: false,
              repeats: 1,
            },
            { type: 'comparison', agentic: false, repeats: 1 },
          ],
          review: { questions: 'tasks/describe-repo/checklist.md' },
        },
      ],
    });
    const loaded = await loadSuite(new FileSuiteSource(suiteDir));
    expect(loaded.ok).toBe(true);
    expect(await readFile(join(suiteDir, '.gitignore'), 'utf8')).toBe('runs/\nreports/\n');
    const checklist = await readFile(join(suiteDir, 'tasks/describe-repo/checklist.md'), 'utf8');
    expect(checklist.trimEnd().split('\n')).toHaveLength(3);
    expect(ran.stdout).toContain(`commit ${commit}`);
    expect(ran.stdout).toContain('deletes 3 files: .claude/settings.json, AGENTS.md, CLAUDE.md');
    expect(ran.stdout).toContain('placebo run --runs 1');
    expect(ran.stdout).not.toContain('cost');
  });

  it('writes a suite placebo run can run with the fake runner', async () => {
    await makeRepo({ 'CLAUDE.md': 'Be brief.\n', 'README.md': '# shop\n' });
    expect((await run(PINNED)).exitCode).toBe(0);
    const template = join(temp, 'template.html');
    await writeFile(template, RESULTS_PLACEHOLDER);
    const ran = await run(['run', '--runner', 'fake', '--runs', '1', '--seed', '1'], {
      reportTemplate: template,
    });
    expect(ran.stderr).not.toContain('error');
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toMatch(/^ {2}pass rate {5}0 pts/m);
  }, 60_000);

  it('writes no none variant when the repo has no configuration to strip', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    const ran = await run(PINNED);
    expect(ran.exitCode).toBe(0);
    expect(existsSync(join(repo, '.placebo', 'variants'))).toBe(false);
    const yaml = await readFile(join(repo, '.placebo', 'suite.yaml'), 'utf8');
    expect(yaml).toContain('variants: {}\n');
    expect(yaml).not.toContain('setup:');
    expect(ran.stdout).toContain('the repo has no Claude Code configuration to strip');
    expect(ran.stdout).toContain('no setup command (no lockfile found)');
  });

  it('refuses when .placebo/ exists unless --force', async () => {
    await makeRepo({ 'CLAUDE.md': 'x\n' });
    await put(repo, { '.placebo/suite.yaml': 'old' });
    const refused = await run(PINNED);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('already exists; pass --force');
    expect(await readFile(join(repo, '.placebo', 'suite.yaml'), 'utf8')).toBe('old');
    const forced = await run([...PINNED, '--force']);
    expect(forced.exitCode).toBe(0);
    expect(await readFile(join(repo, '.placebo', 'suite.yaml'), 'utf8')).toContain(commit);
  });

  it('refuses a repo with no commit', async () => {
    const ran = await run(PINNED);
    expect(ran.exitCode).toBe(2);
    expect(ran.stderr).toContain('has no commit yet');
  });

  it('notes uncommitted changes, since the experiment runs the commit', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    await writeFile(join(repo, 'README.md'), '# edited\n');
    expect((await run(PINNED)).stdout).toContain('uncommitted changes are not part');
  });

  it('asks Claude Code for the default and Opus, and says what it cost', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    const calls: Options[] = [];
    const answers: Record<string, string> = { default: 'claude-sonnet-5', opus: 'claude-opus-5-5' };
    const modelQuery: QueryFunction = ({ options }) => {
      calls.push(options);
      const model = answers[options.model ?? 'default'] ?? 'unknown';
      return (async function* () {
        await Promise.resolve();
        yield { type: 'system', subtype: 'init', model, claude_code_version: '2.1.283', tools: [] };
        yield { type: 'result', total_cost_usd: 0.004 };
      })();
    };
    const ran = await run(['init'], { modelQuery });
    expect(ran.exitCode).toBe(0);
    expect(calls.map((options) => options.model)).toEqual([undefined, 'opus']);
    expect(calls[0]?.cwd).toBe(repo);
    expect(ran.stdout).toContain('asking Claude Code for the model IDs cost $0.01');
    const yaml = await readFile(join(repo, '.placebo', 'suite.yaml'), 'utf8');
    expect(yaml).toContain(
      'model: claude-sonnet-5            # written by init from your current default',
    );
    expect(yaml).toContain(
      'judge_model: claude-opus-5-5      # written by init from the current Opus',
    );
  });

  it('judges with Sonnet when the default model is the current Opus, and says why', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    const modelQuery: QueryFunction = ({ options }) => {
      const model = options.model === 'sonnet' ? 'claude-sonnet-5' : 'claude-opus-5-5';
      return (async function* () {
        await Promise.resolve();
        yield { type: 'system', subtype: 'init', model, claude_code_version: '2.1.283', tools: [] };
      })();
    };
    const ran = await run(['init'], { modelQuery });
    expect(ran.stdout).toContain(
      'the current Opus is also the subject model (claude-opus-5-5); a model judging its own work favours it, so the judge is the current Sonnet',
    );
    const yaml = await readFile(join(repo, '.placebo', 'suite.yaml'), 'utf8');
    expect(yaml).toContain('model: claude-opus-5-5 ');
    expect(yaml).toContain(
      'judge_model: claude-sonnet-5      # written by init from the current Sonnet',
    );
  });

  it('asks only for what the flags leave out, and warns when both are the same', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    const ran = await run([
      'init',
      '--model',
      'claude-opus-5-5',
      '--judge-model',
      'claude-opus-5-5',
    ]);
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toContain('warning: the judge model is the subject model (claude-opus-5-5)');
  });

  it('exits 1 and names the flags when Claude Code cannot be asked', async () => {
    await makeRepo({ 'README.md': '# shop\n' });
    const ran = await run(['init', '--judge-model', 'claude-opus-5-5']);
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr).toContain(
      'error: could not ask Claude Code for the model IDs: no network in tests',
    );
    expect(ran.stderr).toContain('pass --model <id> and --judge-model <id>');
    expect(existsSync(join(repo, '.placebo'))).toBe(false);
  });
});
