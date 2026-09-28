// The release workflow's publish step. changesets runs it whenever no changeset is pending, which
// includes every push before the first version bump; publishing then would try placebo-eval@0.0.0,
// so a 0.0.0 version means there is nothing to release. Otherwise builds and runs
// `changeset publish`, whose output the changesets action reads to tag and create releases.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('../packages/cli/package.json', import.meta.url), 'utf8'),
) as { readonly version?: unknown };

if (manifest.version === '0.0.0') {
  console.log('nothing to release: version is 0.0.0');
  process.exit(0);
}

const steps: readonly (readonly string[])[] = [
  ['pnpm', 'build'],
  ['pnpm', 'exec', 'changeset', 'publish'],
];
for (const [command, ...args] of steps) {
  const result = spawnSync(command ?? '', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
