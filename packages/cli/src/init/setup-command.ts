import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Lockfile at the repo root and the install command it implies, first match wins. */
export const SETUP_COMMANDS: readonly (readonly [lockfile: string, command: string])[] = [
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
];

/** The setup command for the repo's lockfile, or undefined when it has none. */
export function detectSetup(repoRoot: string): { lockfile: string; command: string } | undefined {
  for (const [lockfile, command] of SETUP_COMMANDS) {
    if (existsSync(join(repoRoot, lockfile))) return { lockfile, command };
  }
  return undefined;
}
