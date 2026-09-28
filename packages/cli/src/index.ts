#!/usr/bin/env node
import { main } from './program.js';

await main(process.argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  },
});
