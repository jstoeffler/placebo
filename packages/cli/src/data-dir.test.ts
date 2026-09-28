import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@placebo-eval/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ancestorConfiguration, dataDirOf, foldersRootOf } from './data-dir.js';

describe('dataDirOf', () => {
  it('names the data dir after the repo and a hash of its path, under ~/.placebo', () => {
    const hash = sha256('/work/shop').slice(0, 8);
    expect(dataDirOf('/work/shop', {}, '/home/ada')).toBe(`/home/ada/.placebo/shop-${hash}`);
    expect(dataDirOf('/work/shop/', {}, '/home/ada')).toBe(`/home/ada/.placebo/shop-${hash}`);
    expect(dataDirOf('/other/shop', {}, '/home/ada')).not.toBe(`/home/ada/.placebo/shop-${hash}`);
  });

  it('uses PLACEBO_HOME instead of ~/.placebo when set', () => {
    const hash = sha256('/work/shop').slice(0, 8);
    expect(dataDirOf('/work/shop', { PLACEBO_HOME: '/data/placebo' }, '/home/ada')).toBe(
      `/data/placebo/shop-${hash}`,
    );
    expect(dataDirOf('/work/shop', { PLACEBO_HOME: '' }, '/home/ada')).toBe(
      `/home/ada/.placebo/shop-${hash}`,
    );
  });

  it('puts run folders in folders/', () => {
    expect(foldersRootOf('/data/shop-1')).toBe('/data/shop-1/folders');
  });
});

describe('ancestorConfiguration', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'placebo-ancestors-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds memory files and .claude directories above the run folders, nearest first', async () => {
    const home = join(root, 'home');
    const folders = join(home, '.placebo', 'shop-12345678', 'folders');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.placebo', '.claude'), { recursive: true });
    await writeFile(join(home, 'CLAUDE.md'), 'personal rules');
    await writeFile(join(home, 'AGENTS.md'), 'more rules');
    await writeFile(join(root, 'CLAUDE.local.md'), 'local');
    // A directory named CLAUDE.md is not a memory file.
    await mkdir(join(home, '.placebo', 'CLAUDE.md'));
    const found = await ancestorConfiguration(folders, {}, home);
    expect(found.filter((path) => path.startsWith(root))).toEqual([
      join(home, '.placebo', '.claude'),
      join(home, 'CLAUDE.md'),
      join(home, 'AGENTS.md'),
      join(root, 'CLAUDE.local.md'),
    ]);
  });

  it('leaves out the user config directory, also when relocated', async () => {
    const home = join(root, 'home');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(root, '.claude'), { recursive: true });
    const found = await ancestorConfiguration(
      join(home, 'data', 'folders'),
      {
        CLAUDE_CONFIG_DIR: join(root, '.claude'),
      },
      home,
    );
    expect(found.filter((path) => path.startsWith(root))).toEqual([]);
  });
});
