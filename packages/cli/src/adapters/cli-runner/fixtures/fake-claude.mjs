#!/usr/bin/env node
// A stand-in for `claude` in CliRunner tests. Spends no tokens and touches no network.
//   FAKE_CLAUDE_RECORD  file to write { argv, cwd, env } to
//   FAKE_CLAUDE_STREAM  NDJSON file echoed to stdout
//   FAKE_CLAUDE_STDERR  text written to stderr
//   FAKE_CLAUDE_EXIT    exit code (default 0)
//   FAKE_CLAUDE_HANG    when set, never exits on its own
//   FAKE_CLAUDE_VERSION output of `--version` (default `2.1.283 (Claude Code)`)
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? '2.1.283 (Claude Code)'}\n`);
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
}
if (process.env.FAKE_CLAUDE_RECORD) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('CLAUDE') || key === 'KEEP_ME'),
  );
  writeFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({ argv: args, cwd: process.cwd(), env }),
  );
}
if (process.env.FAKE_CLAUDE_STREAM) {
  process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_STREAM, 'utf8'));
}
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);
if (process.env.FAKE_CLAUDE_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0);
