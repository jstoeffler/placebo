// PostToolUse hook (Edit, Write, MultiEdit): lints the touched TypeScript file and typechecks its
// package, so type and lint errors surface right after the edit instead of at `pnpm check`.
// Reports only; never fixes. Exit 2 feeds the output back to Claude; exit 0 is silent.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { text } from 'node:stream/consumers';

const MAX_LINES = 40;
const root = resolve(import.meta.dirname, '..');

interface HookInput {
  readonly tool_input?: { readonly file_path?: unknown };
}

interface Outcome {
  readonly label: string;
  readonly code: number;
  readonly output: string;
}

function run(label: string, bin: string, args: readonly string[]): Promise<Outcome> {
  return new Promise((done) => {
    const child = spawn(resolve(root, 'node_modules/.bin', bin), args, { cwd: root });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (error) => {
      done({ label, code: 1, output: error.message });
    });
    child.on('close', (code) => {
      done({ label, code: code ?? 1, output });
    });
  });
}

const input = JSON.parse(await text(process.stdin)) as HookInput;
const filePath = input.tool_input?.file_path;
if (typeof filePath !== 'string' || !/\.[cm]?tsx?$/.test(filePath)) process.exit(0);

const file = relative(root, resolve(filePath));
if (
  file.startsWith('..') ||
  /(^|\/)(node_modules|dist|\.tsbuild)\//.test(file) ||
  !existsSync(filePath)
) {
  process.exit(0);
}

const packageDir = /^packages\/[^/]+/.exec(file.split(sep).join('/'))?.[0];
const project = packageDir ?? 'tsconfig.json';

const outcomes = await Promise.all([
  run('eslint', 'eslint', ['--max-warnings=0', '--no-warn-ignored', file]),
  run(`tsc -b ${project}`, 'tsc', ['-b', project, '--pretty', 'false']),
]);

const failures = outcomes.filter((outcome) => outcome.code !== 0);
if (failures.length === 0) process.exit(0);

for (const failure of failures) {
  const lines = failure.output.trim().split('\n');
  const shown = lines.slice(0, MAX_LINES).join('\n');
  const more = lines.length > MAX_LINES ? `\n… ${String(lines.length - MAX_LINES)} more lines` : '';
  process.stderr.write(`${failure.label} failed after editing ${file}:\n${shown}${more}\n\n`);
}
process.exit(2);
