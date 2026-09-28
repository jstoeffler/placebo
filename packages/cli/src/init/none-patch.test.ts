import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isClaudeConfiguration, nonePatch } from './none-patch.js';

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

let temp: string;
let repo: string;

async function commit(files: Record<string, string | Uint8Array>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'files']);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

beforeEach(async () => {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'placebo-none-test-')));
  repo = join(temp, 'repo');
  await mkdir(repo);
  git(repo, ['init', '-q', '-b', 'main']);
});

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

describe('isClaudeConfiguration', () => {
  it.each([
    ['CLAUDE.md', true],
    ['CLAUDE.local.md', true],
    ['AGENTS.md', true],
    ['packages/api/CLAUDE.md', true],
    ['.claude/settings.json', true],
    ['tools/.claude/skills/x/SKILL.md', true],
    ['.mcp.json', true],
    ['docs/.mcp.json', false],
    ['docs/claude.md', false],
    ['README.md', false],
    ['.claudeignore', false],
  ])('%s is %s', (path, expected) => {
    expect(isClaudeConfiguration(path)).toBe(expected);
  });
});

describe('nonePatch', () => {
  it('deletes every configuration file at the commit, and git apply accepts it', async () => {
    const head = await commit({
      'CLAUDE.md': '@AGENTS.md\n',
      'AGENTS.md': '# Rules\n\nKeep it short.\n',
      'CLAUDE.local.md': 'mine\n',
      '.mcp.json': '{}\n',
      '.claude/settings.json': '{ "hooks": {} }\n',
      '.claude/hooks/check.sh': '#!/bin/sh\nexit 0\n',
      '.claude/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]),
      'packages/api/CLAUDE.md': 'api rules\n',
      'README.md': '# repo\n',
      'src/main.ts': 'export {};\n',
    });
    await chmod(join(repo, '.claude/hooks/check.sh'), 0o755);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'executable hook']);
    const pinned = git(repo, ['rev-parse', 'HEAD']).trim();
    expect(pinned).not.toBe(head);
    // Uncommitted edits never reach the patch: it is built from the commit.
    await writeFile(join(repo, 'CLAUDE.md'), 'edited, not committed\n');

    const none = await nonePatch(repo, pinned);
    expect(none?.paths).toEqual([
      '.claude/hooks/check.sh',
      '.claude/logo.png',
      '.claude/settings.json',
      '.mcp.json',
      'AGENTS.md',
      'CLAUDE.local.md',
      'CLAUDE.md',
      'packages/api/CLAUDE.md',
    ]);

    const clone = join(temp, 'clone');
    git(temp, ['clone', '-q', repo, clone]);
    await writeFile(join(temp, 'none.patch'), none?.patch ?? '');
    git(clone, ['apply', '--check', join(temp, 'none.patch')]);
    git(clone, ['apply', join(temp, 'none.patch')]);
    for (const path of none?.paths ?? []) expect(existsSync(join(clone, path)), path).toBe(false);
    expect(await readFile(join(clone, 'README.md'), 'utf8')).toBe('# repo\n');
    expect(existsSync(join(clone, 'src/main.ts'))).toBe(true);
    expect(git(clone, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(8);
  });

  it('is undefined when the commit tracks no configuration', async () => {
    const head = await commit({ 'README.md': '# repo\n' });
    // Untracked configuration does not count: only the commit reaches a snapshot.
    await writeFile(join(repo, 'CLAUDE.md'), 'untracked\n');
    expect(await nonePatch(repo, head)).toBeUndefined();
  });

  it('fails on a commit that does not exist', async () => {
    await commit({ 'README.md': '# repo\n' });
    await expect(nonePatch(repo, 'f'.repeat(40))).rejects.toThrow(/git ls-tree failed/);
  });
});
