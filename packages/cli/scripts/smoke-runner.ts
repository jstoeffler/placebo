/* eslint-disable no-console -- a script whose output is the point. */
// Smoke run of both runners against the real Claude Code, spending real tokens. Never part of
// Vitest. Run with `pnpm --filter placebo-eval smoke`; add `--record` to rewrite the recorded
// fixtures under src/adapters/*/fixtures from this run (home and temp paths are replaced), and
// `--scenario=a,b` to run only those scenarios.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_SETTING_SOURCES,
  type RunRequest,
  type Runner,
  type RunnerEvent,
} from '@placebo-eval/core';
import { CliRunner, type SpawnFunction } from '../src/adapters/cli-runner/cli-runner.js';
import { SdkRunner } from '../src/adapters/sdk-runner/sdk-runner.js';

const MODEL = 'claude-haiku-4-5-20251001';
const record = process.argv.includes('--record');
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const scenarios = process.argv
  .find((arg) => arg.startsWith('--scenario='))
  ?.slice('--scenario='.length)
  .split(',');
const adapters = new URL('../src/adapters/', import.meta.url);

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    first_line_says_hi: { type: 'boolean' },
    rest_unchanged: { type: 'boolean' },
  },
  required: ['first_line_says_hi', 'rest_unchanged'],
  additionalProperties: false,
};

interface Scenario {
  readonly name: string;
  readonly request: (cwd: string) => RunRequest;
}

const subject = (cwd: string): RunRequest => ({
  cwd,
  prompt: 'Add a comment line at the top of hello.txt saying hi. Do nothing else.',
  model: MODEL,
  settingSources: DEFAULT_SETTING_SOURCES,
  sandbox: true,
  strictMcpConfig: true,
  limits: {},
  tools: 'all',
});

const SCENARIOS: readonly Scenario[] = [
  { name: 'subject', request: subject },
  {
    name: 'judge',
    request: (cwd) => ({
      cwd,
      prompt: [
        'An agent was asked to add a comment line saying hi at the top of hello.txt.',
        'The file now reads:',
        '```',
        '# hi',
        'hello',
        '```',
        'Answer both questions.',
      ].join('\n'),
      model: MODEL,
      settingSources: [],
      sandbox: true,
      strictMcpConfig: true,
      limits: {},
      tools: 'none',
      maxTurns: 1,
      outputSchema: JUDGE_SCHEMA,
      systemPrompt: 'You are a judge. Answer only through the structured output.',
    }),
  },
  {
    name: 'read-only-judge',
    request: (cwd) => ({
      cwd,
      prompt: 'Use Glob to list the files here, then Grep for "hello". Report what you found.',
      model: MODEL,
      settingSources: [],
      sandbox: true,
      strictMcpConfig: true,
      limits: {},
      tools: 'read_only',
    }),
  },
  { name: 'max-turns', request: (cwd) => ({ ...subject(cwd), limits: { maxTurns: 1 } }) },
  { name: 'timeout', request: (cwd) => ({ ...subject(cwd), limits: { maxDurationMs: 4000 } }) },
  {
    name: 'sync-subagent',
    request: (cwd) => ({
      ...subject(cwd),
      prompt:
        'Use the Agent tool exactly once, with subagent_type general-purpose, to have a subagent add a comment line at the top of hello.txt saying hi. Wait for its result, then reply done.',
      tools: 'subject',
    }),
  },
  {
    name: 'background-subagent',
    request: (cwd) => ({
      ...subject(cwd),
      prompt:
        "Use the Agent tool exactly once, with run_in_background true and subagent_type general-purpose, to have a subagent run the shell command 'sleep 5' and then add a comment line at the top of hello.txt saying hi. Right after launching it, reply launched and end your turn without waiting for it.",
      tools: 'subject',
      backgroundWork: true,
    }),
  },
];

function runFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'placebo-smoke-')));
  writeFileSync(join(dir, 'hello.txt'), 'hello\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Smoke\n\nKeep edits minimal.\n');
  return dir;
}

function sanitize(text: string, dir: string): string {
  return text
    .replaceAll(dir, '/tmp/placebo-smoke')
    .replaceAll(dir.replace(/^\/private/, ''), '/tmp/placebo-smoke')
    .replaceAll(dir.replaceAll(/[^a-zA-Z0-9]/g, '-'), '-tmp-placebo-smoke')
    .replaceAll(homedir(), '/home/user');
}

/** Stream noise the translator ignores; dropped from recordings to keep fixtures readable. */
function isNoise(message: unknown): boolean {
  const { type, subtype, event } = message as {
    type?: string;
    subtype?: string;
    event?: { type?: string };
  };
  if (type === 'system' && subtype === 'thinking_tokens') return true;
  return type === 'stream_event' && !['message_start', 'message_delta'].includes(event?.type ?? '');
}

function compact(event: RunnerEvent): string {
  switch (event.type) {
    case 'system_init':
      return `system_init model=${event.model} version=${event.claudeCodeVersion} tools=${event.tools.join(',')}`;
    case 'assistant_text':
      return `assistant_text ${JSON.stringify(event.text.slice(0, 120))}`;
    case 'tool_call':
      return `tool_call ${event.name} ${JSON.stringify(event.input).slice(0, 120)}`;
    case 'tool_result':
      return `tool_result error=${String(event.isError)} ${JSON.stringify(event.output.slice(0, 120))}`;
    case 'usage':
      return `usage in=${String(event.input)} out=${String(event.output)} cacheRead=${String(event.cacheRead)} cacheWrite=${String(event.cacheWrite)}`;
    case 'result':
      return `result ${JSON.stringify({ ...event, timestamp: undefined })}`;
  }
}

async function main(): Promise<void> {
  let recorded: unknown[] = [];
  let recordedLines: string[] = [];
  const recordingQuery = (params: { prompt: string; options: Options }): AsyncIterable<unknown> => {
    const messages = query(params);
    return (async function* () {
      for await (const message of messages) {
        recorded.push(message);
        yield message;
      }
    })();
  };
  const recordingSpawn = ((command: string, args: readonly string[], options: object) => {
    const child: ChildProcess = spawn(command, args, options);
    child.stdout?.on('data', (chunk: Buffer) => recordedLines.push(chunk.toString('utf8')));
    return child;
  }) as SpawnFunction;

  const runners: [string, Runner, () => string][] = [
    [
      'sdk',
      new SdkRunner({ query: recordingQuery }),
      () =>
        `${JSON.stringify(
          recorded.filter((m) => !isNoise(m)),
          null,
          2,
        )}\n`,
    ],
    [
      'cli',
      new CliRunner({ spawn: recordingSpawn }),
      () =>
        `${recordedLines
          .join('')
          .split('\n')
          .filter((line) => line.trim() !== '' && !isNoise(JSON.parse(line)))
          .join('\n')}\n`,
    ],
  ];

  let totalCost = 0;
  for (const [name, runner, dump] of runners) {
    if (only !== undefined && !only.split(',').includes(name)) continue;
    console.log(`\n=== ${name} runner, claudeCodeVersion() = ${await runner.claudeCodeVersion()}`);
    for (const scenario of SCENARIOS) {
      if (scenarios !== undefined && !scenarios.includes(scenario.name)) continue;
      recorded = [];
      recordedLines = [];
      const dir = runFolder();
      console.log(`\n--- ${name} / ${scenario.name} (${dir})`);
      try {
        const result = await runner.run(scenario.request(dir), (event) => {
          console.log(`  ${compact(event)}`);
        });
        totalCost += result.result.costUsd;
        console.log(
          `  => outcome=${result.result.outcome} cost=$${result.result.costUsd.toFixed(4)} model=${result.model} version=${result.claudeCodeVersion} usage=${JSON.stringify(result.usage)}`,
        );
      } catch (error) {
        console.log(`  => threw ${String(error)}`);
      }
      if (record) {
        const folder = new URL(`${name}-runner/fixtures/`, adapters);
        mkdirSync(folder, { recursive: true });
        const file =
          name === 'sdk'
            ? `sdk-messages-${scenario.name}.json`
            : `cli-stream-${scenario.name}.ndjson`;
        writeFileSync(new URL(file, folder), sanitize(dump(), dir));
      }
    }
  }
  console.log(`\nTotal reported cost: $${totalCost.toFixed(4)}`);
}

await main();
