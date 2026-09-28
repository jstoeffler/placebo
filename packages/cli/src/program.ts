import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { runCommand, type RunFlags } from './commands/run.js';
import { EXIT, UsageError } from './errors.js';
import { type Host, type Io, processHost } from './host.js';
import { collect, keepPolicy, positiveInteger, runnerKind, seedValue } from './options.js';
import { VERSION } from './version.js';

export type { Io } from './host.js';

/** Exit code of commands that exist in the surface but are not built yet. */
export const NOT_IMPLEMENTED_EXIT_CODE = EXIT.usage;

/**
 * Runs a command action, turning its outcome into an exit code: its own return value, 2 for a
 * `UsageError`, 1 for anything else thrown.
 */
function action<Args extends unknown[]>(
  io: Io,
  body: (...args: Args) => Promise<number>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      io.setExitCode(await body(...args));
    } catch (error) {
      if (error instanceof UsageError) {
        io.stderr(`${error.message}\n`);
        io.setExitCode(EXIT.usage);
        return;
      }
      io.stderr(`${pc.red('error:')} ${error instanceof Error ? error.message : String(error)}\n`);
      io.setExitCode(EXIT.failed);
    }
  };
}

function createProgram(io: Io, hostOverrides: Partial<Host> = {}): Command {
  const host: Host = { ...processHost(), ...hostOverrides };
  const program = new Command()
    .name('placebo')
    .description('Measure whether a Claude Code configuration change actually helps.')
    .version(VERSION, '-v, --version')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError()
    // Before any subcommand exists, so every one inherits it; `main` maps the codes.
    .exitOverride();

  program
    .command('init')
    .description('create .placebo/, pin models and commit, generate none.patch, scaffold a task')
    .action(() => {
      io.stderr(`${pc.yellow('placebo init: not implemented yet')}\n`);
      io.setExitCode(NOT_IMPLEMENTED_EXIT_CODE);
    });

  program
    .command('run')
    .description('run the suite, print card and table, write report and results')
    .option('--suite <dir>', 'suite folder (default: .placebo at the repo root)')
    .option('--runs <n>', 'runs per task per arm (default: the suite)', positiveInteger)
    .option('--parallelism <n>', 'runs in flight at once (default: the suite)', positiveInteger)
    .option('--task <id>', 'run only this task; repeatable', collect)
    .option('--variant <name>', 'run only this treatment with control; repeatable', collect)
    .option(
      '--keep <which>',
      'run folders to keep: all, reviewable or none (default: all)',
      keepPolicy,
    )
    .option(
      '--seed <n>',
      'seed of every random choice (default: random, always printed)',
      seedValue,
    )
    .option('--runner <name>', 'sdk or cli (default: sdk)', runnerKind)
    .option('--sandbox', "run agents in Claude Code's sandbox (default: the suite)")
    .option('--no-sandbox', "run agents without Claude Code's sandbox")
    .option('--out <dir>', 'report folder (default: .placebo/reports/<experiment id>)')
    .option('--no-color', 'print without colour')
    .option('--quiet', 'print no progress, only warnings and the results')
    .action(action(io, (flags: RunFlags) => runCommand(flags, io, host)));

  for (const [name, description] of [
    ['review', 'serve the report locally with blinded review mode'],
    ['report', 'regenerate the HTML report from the run store'],
    ['clean', 'remove kept run folders'],
  ] as const) {
    program
      .command(name)
      .description(description)
      .action(() => {
        io.stderr(`${pc.yellow(`placebo ${name}: not implemented yet`)}\n`);
        io.setExitCode(NOT_IMPLEMENTED_EXIT_CODE);
      });
  }
  return program;
}

/**
 * Parses `argv` (as `process.argv`) and runs the command. Usage errors commander finds (unknown
 * command or flag, bad value) exit 2 like every other usage error; help and version exit 0.
 */
export async function main(
  argv: readonly string[],
  io: Io,
  hostOverrides: Partial<Host> = {},
): Promise<void> {
  const program = createProgram(io, hostOverrides).exitOverride();
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    io.setExitCode(error.exitCode === 0 ? EXIT.ok : EXIT.usage);
  }
}
