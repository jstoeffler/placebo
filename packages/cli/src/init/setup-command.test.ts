import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSetup, SETUP_COMMANDS } from './setup-command.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'placebo-setup-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('detectSetup', () => {
  it.each([
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
    ['package-lock.json', 'npm ci'],
    ['yarn.lock', 'yarn install --frozen-lockfile'],
    ['bun.lock', 'bun install'],
    ['bun.lockb', 'bun install'],
    ['uv.lock', 'uv sync'],
    ['poetry.lock', 'poetry install'],
    ['requirements.txt', 'pip install -r requirements.txt'],
    ['Cargo.lock', 'cargo fetch'],
    ['go.sum', 'go mod download'],
    ['Gemfile.lock', 'bundle install'],
  ])('maps %s to %s', async (lockfile, command) => {
    await writeFile(join(repo, lockfile), '');
    expect(detectSetup(repo)).toEqual({ lockfile, command });
  });

  it('covers every lockfile it knows', () => {
    expect(SETUP_COMMANDS).toHaveLength(11);
  });

  it('takes the first lockfile in order when there are several', async () => {
    await writeFile(join(repo, 'requirements.txt'), '');
    await writeFile(join(repo, 'package-lock.json'), '');
    expect(detectSetup(repo)?.command).toBe('npm ci');
  });

  it('finds nothing without a lockfile', () => {
    expect(detectSetup(repo)).toBeUndefined();
  });
});
