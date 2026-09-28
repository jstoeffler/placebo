// Proves the published placebo-eval package works: every bare import of the bundle is a declared
// dependency, the report template ships inside it, and a fresh project that installs the packed
// tarball can run `placebo --help` and `placebo --version`. Run after `pnpm build` with
// `pnpm verify:package`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli');
const REPORT_PLACEHOLDER = '<!--PLACEBO_RESULTS-->';
/** Packages the bundle inlines; an import of one of them means the bundling broke. */
const MUST_BE_BUNDLED = ['@placebo-eval/core', 'zod', 'yaml'];

interface Manifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
}

const manifest = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')) as Manifest;
const failures: string[] = [];

function fail(message: string): void {
  failures.push(message);
  console.error(`✗ ${message}`);
}

function pass(message: string): void {
  console.log(`✓ ${message}`);
}

function run(command: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with ${String(result.status)}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

/** The package a bare specifier names: `@scope/name` or `name`, without any subpath. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function checkBareImports(): void {
  const builtins = new Set(builtinModules);
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const packages = new Set<string>();
  for (const file of readdirSync(join(CLI, 'dist')).filter((name) => name.endsWith('.js'))) {
    const code = readFileSync(join(CLI, 'dist', file), 'utf8');
    // The TypeScript preprocessor skips comments and strings, which a regex would not.
    const { importedFiles } = ts.preProcessFile(code, true, true);
    for (const { fileName: specifier } of importedFiles) {
      if (specifier.startsWith('.') || specifier.startsWith('node:') || builtins.has(specifier)) {
        continue;
      }
      packages.add(packageName(specifier));
    }
  }
  for (const name of packages) {
    if (MUST_BE_BUNDLED.includes(name)) fail(`dist imports ${name}, which must be bundled`);
    else if (!declared.has(name)) fail(`dist imports ${name}, which is not in dependencies`);
  }
  pass(`bare imports of dist: ${[...packages].sort().join(', ') || 'none'}`);
}

function checkTarball(tarball: string): void {
  const entries = new Set(
    run('tar', ['-tzf', tarball], ROOT)
      .split('\n')
      .map((line) => line.replace(/^package\//, '')),
  );
  for (const required of ['bin/placebo.js', 'dist/index.js', 'dist/report.html']) {
    if (entries.has(required)) pass(`tarball ships ${required}`);
    else fail(`tarball does not ship ${required}`);
  }
  const report = readFileSync(join(CLI, 'dist', 'report.html'), 'utf8');
  if (report.includes(REPORT_PLACEHOLDER)) pass('report.html has the results placeholder');
  else fail(`report.html has no ${REPORT_PLACEHOLDER} placeholder`);
}

function checkInstall(tarball: string, work: string): void {
  const project = join(work, 'project');
  mkdirSync(project);
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'verify-placebo', private: true, type: 'module' }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], project);
  pass('npm install of the tarball in a fresh project');

  const help = run('npx', ['--no-install', 'placebo', '--help'], project);
  if (help.startsWith('Usage: placebo')) pass('placebo --help');
  else fail(`placebo --help printed:\n${help}`);

  const version = run('npx', ['--no-install', 'placebo', '--version'], project).trim();
  if (version === manifest.version) pass(`placebo --version is ${version}`);
  else fail(`placebo --version printed ${version}, expected ${manifest.version}`);
}

const work = mkdtempSync(join(tmpdir(), 'placebo-verify-'));
try {
  checkBareImports();
  run('pnpm', ['--filter', 'placebo-eval', 'pack', '--pack-destination', work], ROOT);
  const tarball = readdirSync(work).find((file) => file.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('pnpm pack wrote no tarball');
  checkTarball(join(work, tarball));
  checkInstall(join(work, tarball), work);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} package check(s) failed.`);
  process.exitCode = 1;
}
