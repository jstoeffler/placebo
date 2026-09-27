#!/usr/bin/env node
import { createProgram } from './program.js';

const program = createProgram({
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

await program.parseAsync(process.argv);
