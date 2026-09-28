import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeRunner, MemoryRunStore, systemClock } from '@placebo-eval/core';
import { makeExperiment, makeReview, makeRun } from '@placebo-eval/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliRunner } from './adapters/cli-runner/cli-runner.js';
import { SdkRunner } from './adapters/sdk-runner/sdk-runner.js';
import { createRunner, ObservedRunStore, resolveRepo, workspaceOf } from './composition.js';
import { dataDirOf } from './data-dir.js';

describe('resolveRepo', () => {
  it.each([
    ['.', '/work/shop'],
    ['../lib', '/work/lib'],
    ['/abs/repo', '/abs/repo'],
    ['https://github.com/placebo-eval/placebo.git', 'https://github.com/placebo-eval/placebo.git'],
    ['git@github.com:placebo-eval/placebo.git', 'git@github.com:placebo-eval/placebo.git'],
  ])('resolves %s against the repo root', (repo, expected) => {
    expect(resolveRepo(repo, '/work/shop')).toBe(expected);
  });
});

describe('createRunner', () => {
  it('builds the runner each kind names', () => {
    expect(createRunner('sdk', systemClock, {})).toBeInstanceOf(SdkRunner);
    expect(createRunner('cli', systemClock, {})).toBeInstanceOf(CliRunner);
    expect(createRunner('fake', systemClock, {})).toBeInstanceOf(FakeRunner);
  });
});

describe('workspaceOf', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'placebo-workspace-')));
    execFileSync('git', ['init', '-q', root]);
    await mkdir(join(root, 'src'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the repo root from a subdirectory and keeps results next to the suite', async () => {
    const workspace = await workspaceOf({ cwd: join(root, 'src'), env: {}, home: '/home/ada' });
    expect(workspace).toEqual({
      repoRoot: root,
      suiteDir: join(root, '.placebo'),
      dataDir: dataDirOf(root, {}, '/home/ada'),
      storeDir: join(root, '.placebo', 'runs'),
      reportsDir: join(root, '.placebo', 'reports'),
    });
  });

  it('takes --suite relative to the current directory', async () => {
    const workspace = await workspaceOf({ cwd: join(root, 'src'), suite: '../suites/a', env: {} });
    expect(workspace.suiteDir).toBe(join(root, 'suites', 'a'));
    expect(workspace.storeDir).toBe(join(root, 'suites', 'a', 'runs'));
  });

  it('refuses a directory outside any git repository', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'placebo-nogit-')));
    try {
      await expect(workspaceOf({ cwd: outside, env: {} })).rejects.toThrow(
        /not inside a git repository/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('ObservedRunStore', () => {
  it('passes every call through and reports saved runs', async () => {
    const saved: string[] = [];
    const inner = new MemoryRunStore();
    const store = new ObservedRunStore(inner, (run) => saved.push(run.id));
    const run = makeRun();
    await store.save(run);
    expect(saved).toEqual([run.id]);
    expect(await store.get(run.id)).toEqual(run);
    expect(await store.list()).toEqual([run]);
    const experiment = makeExperiment({ id: run.experimentId });
    await store.saveExperiment(experiment);
    expect(await store.listExperiments()).toEqual([experiment]);
    expect(await store.getExperiment(run.experimentId)).toEqual(experiment);
    const review = makeReview({ runId: run.id });
    await store.saveReview(review);
    expect(await store.listReviews({ runId: run.id })).toEqual([review]);
    expect(saved).toEqual([run.id]);
  });
});
