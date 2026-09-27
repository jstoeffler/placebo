import { Command } from 'commander';
import pc from 'picocolors';
import { VERSION } from './version.js';

/** Where the program writes; the real process in `index.ts`, buffers in tests. */
export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
}

/** Exit code of commands that exist in the surface but are not built yet. */
export const NOT_IMPLEMENTED_EXIT_CODE = 2;

/** The v0.1 command surface (brief §12), descriptions verbatim. */
const COMMANDS = [
  ['init', 'create .placebo/, pin models and commit, generate none.patch, scaffold a task'],
  ['run', 'run the suite, print card and table, write report and results'],
  ['review', 'serve the report locally with blinded review mode'],
  ['report', 'regenerate the HTML report from the run store'],
  ['clean', 'remove kept run folders'],
] as const;

export function createProgram(io: Io): Command {
  const program = new Command()
    .name('placebo')
    .description('Measure whether a Claude Code configuration change actually helps.')
    .version(VERSION, '-v, --version')
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError();

  for (const [name, description] of COMMANDS) {
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
