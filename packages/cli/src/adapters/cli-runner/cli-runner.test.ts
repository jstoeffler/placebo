import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRequest, RunnerEvent } from '@placebo-eval/core';
import { describe, expect, it } from 'vitest';
import { StreamProtocolError } from '../sdk-runner/stream.js';
import {
  cliMessages,
  JUDGE_REQUEST,
  JUDGE_SCHEMA,
  READ_ONLY_JUDGE_REQUEST,
  type RecordedScenario,
  steppingClock,
  SUBJECT_REQUEST,
  toNdjson,
  withoutResult,
} from '../sdk-runner/test-support.js';
import { cliArgs, CliRunner, parseClaudeVersion } from './cli-runner.js';

const FAKE_CLAUDE = new URL('fixtures/fake-claude.mjs', import.meta.url).pathname;

interface Fake {
  readonly stream?: string;
  readonly stderr?: string;
  readonly exit?: number;
  readonly hang?: boolean;
  readonly version?: string;
  readonly executable?: string;
}

function setup(fake: Fake = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'placebo-cli-runner-'));
  const recordFile = join(dir, 'record.json');
  const streamFile = join(dir, 'stream.ndjson');
  writeFileSync(streamFile, fake.stream ?? '');
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    KEEP_ME: 'yes',
    FAKE_CLAUDE_RECORD: recordFile,
    FAKE_CLAUDE_STREAM: streamFile,
    FAKE_CLAUDE_STDERR: fake.stderr,
    FAKE_CLAUDE_EXIT: fake.exit === undefined ? undefined : String(fake.exit),
    FAKE_CLAUDE_HANG: fake.hang === true ? '1' : undefined,
    FAKE_CLAUDE_VERSION: fake.version,
  };
  const runner = new CliRunner({
    executable: fake.executable ?? FAKE_CLAUDE,
    clock: steppingClock(),
    env,
  });
  const recorded = () =>
    JSON.parse(readFileSync(recordFile, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
  return { dir, runner, recorded };
}

async function runRecorded(
  scenario: RecordedScenario,
  request: RunRequest = SUBJECT_REQUEST,
  fake: Fake = {},
) {
  const harness = setup({ stream: toNdjson(cliMessages(scenario)), ...fake });
  const events: RunnerEvent[] = [];
  const result = await harness.runner.run({ ...request, cwd: harness.dir }, (event) =>
    events.push(event),
  );
  return { ...harness, events, result };
}

const BASE_FLAGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--model',
  'claude-haiku-4-5-20251001',
];
const PERMISSION_FLAGS = [
  '--permission-mode',
  'bypassPermissions',
  '--dangerously-skip-permissions',
];
const SANDBOX_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, allowUnsandboxedCommands: false },
});

describe('CliRunner flags', () => {
  it('passes a subject run as project settings, strict MCP, bypassed permissions and the sandbox', async () => {
    const { recorded, dir } = await runRecorded('subject');
    expect(recorded()).toMatchObject({
      argv: [
        ...BASE_FLAGS,
        '--setting-sources',
        'project',
        ...PERMISSION_FLAGS,
        '--strict-mcp-config',
        '--settings',
        SANDBOX_SETTINGS,
        '--',
        SUBJECT_REQUEST.prompt,
      ],
    });
    expect(recorded().cwd.endsWith(dir.split('/').at(-1) ?? '')).toBe(true);
  });

  it('passes a tool-less judge with no settings, one turn, a schema and an appended prompt', () => {
    expect(cliArgs(JUDGE_REQUEST)).toEqual([
      ...BASE_FLAGS,
      '--setting-sources',
      '',
      ...PERMISSION_FLAGS,
      '--strict-mcp-config',
      '--max-turns',
      '1',
      '--json-schema',
      JSON.stringify(JUDGE_SCHEMA),
      '--append-system-prompt',
      'You are a judge.',
      '--tools',
      '',
      '--disallowedTools',
      'mcp__*',
      '--',
      'Answer both questions.',
    ]);
  });

  it('passes a read-only judge exactly Read, Glob and Grep', () => {
    const args = cliArgs(READ_ONLY_JUDGE_REQUEST);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--'))).toEqual([
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'Read,Glob,Grep',
      '--disallowedTools',
      'mcp__*',
    ]);
  });

  it('adds turn and budget flags only when limits carry them', () => {
    const plain = cliArgs({ ...SUBJECT_REQUEST, sandbox: false, strictMcpConfig: false });
    for (const flag of [
      '--max-turns',
      '--max-budget-usd',
      '--settings',
      '--strict-mcp-config',
      '--tools',
      '--fallback-model',
    ]) {
      expect(plain).not.toContain(flag);
    }
    const limited = cliArgs({ ...SUBJECT_REQUEST, limits: { maxTurns: 30, maxBudgetUsd: 2.5 } });
    expect(
      limited.slice(limited.indexOf('--max-turns'), limited.indexOf('--max-turns') + 4),
    ).toEqual(['--max-turns', '30', '--max-budget-usd', '2.5']);
    expect(cliArgs({ ...SUBJECT_REQUEST, limits: { maxTurns: 30 }, maxTurns: 2 })).toContain('2');
  });

  it('keeps a prompt that looks like a flag after --', () => {
    const args = cliArgs({ ...SUBJECT_REQUEST, prompt: '--help' });
    expect(args.slice(-2)).toEqual(['--', '--help']);
  });

  it('strips the parent-session variables from the child environment', async () => {
    const { recorded } = await runRecorded('subject');
    const { env } = recorded();
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    expect(env).toHaveProperty('KEEP_ME', 'yes');
  });
});

describe('CliRunner translation', () => {
  it('translates the recorded subject run', async () => {
    const { events, result } = await runRecorded('subject');
    // Tools run while a turn still streams, so a turn's usage may follow its tool result.
    expect(events.map((event) => event.type)).toEqual([
      'system_init',
      'tool_call',
      'tool_result',
      'usage',
      'tool_call',
      'tool_result',
      'usage',
      'assistant_text',
      'usage',
      'result',
    ]);
    expect(result).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      claudeCodeVersion: '2.1.283',
      result: { outcome: 'completed', turns: 3, stopReason: 'end_turn' },
    });
  });

  it('carries the structured output of a recorded judge', async () => {
    const { result } = await runRecorded('judge', JUDGE_REQUEST);
    expect(result.result.structuredOutput).toEqual({
      first_line_says_hi: true,
      rest_unchanged: true,
    });
  });

  it('maps the recorded max-turns run to failed even though claude exits 1', async () => {
    const { result } = await runRecorded('max-turns', SUBJECT_REQUEST, { exit: 1 });
    expect(result.result.outcome).toBe('failed');
  });

  it('ignores lines that are not JSON objects', async () => {
    const stream = `warning: something\n\n${toNdjson(cliMessages('judge'))}not json {\n`;
    const { runner, dir } = setup({ stream });
    const result = await runner.run({ ...JUDGE_REQUEST, cwd: dir }, () => undefined);
    expect(result.result.outcome).toBe('completed');
  });

  it('throws a StreamProtocolError on a malformed known message', async () => {
    const { runner, dir } = setup({
      stream: toNdjson([{ type: 'system', subtype: 'init', model: 42 }]),
      hang: true,
    });
    await expect(
      runner.run({ ...SUBJECT_REQUEST, cwd: dir }, () => undefined),
    ).rejects.toBeInstanceOf(StreamProtocolError);
  });
});

describe('CliRunner outcomes and infrastructure errors', () => {
  const started = toNdjson(withoutResult(cliMessages('subject')));

  it('records a crash when claude exits non-zero after starting without a result', async () => {
    const { runner, dir } = setup({ stream: started, exit: 1, stderr: 'segfault' });
    const result = await runner.run({ ...SUBJECT_REQUEST, cwd: dir }, () => undefined);
    expect(result.result).toMatchObject({ outcome: 'crashed', costUsd: 0 });
  });

  it('rejects with spawn_failed when claude exits non-zero before any output', async () => {
    const { runner, dir } = setup({ exit: 1, stderr: 'Error: invalid flag' });
    await expect(
      runner.run({ ...SUBJECT_REQUEST, cwd: dir }, () => undefined),
    ).rejects.toMatchObject({
      name: 'RunnerInfraError',
      reason: 'spawn_failed',
      message: expect.stringContaining('invalid flag') as string,
    });
  });

  it('rejects with spawn_failed when the executable does not exist', async () => {
    const { runner, dir } = setup({ executable: '/nonexistent/claude' });
    await expect(
      runner.run({ ...SUBJECT_REQUEST, cwd: dir }, () => undefined),
    ).rejects.toMatchObject({
      reason: 'spawn_failed',
    });
  });

  it('rejects with rate_limited when stderr reports a 429 and no result arrived', async () => {
    const { runner, dir } = setup({
      stream: started,
      exit: 1,
      stderr: 'API Error: 429 rate_limit_error. retry-after: 20',
    });
    await expect(
      runner.run({ ...SUBJECT_REQUEST, cwd: dir }, () => undefined),
    ).rejects.toMatchObject({
      reason: 'rate_limited',
      retryAfterMs: 20_000,
    });
  });

  it('kills claude after limits.maxDurationMs and records a failed run', async () => {
    const { runner, dir } = setup({ stream: started, hang: true });
    const request = { ...SUBJECT_REQUEST, cwd: dir, limits: { maxDurationMs: 300 } };
    const result = await runner.run(request, () => undefined);
    expect(result.result.outcome).toBe('failed');
  });
});

describe('CliRunner version', () => {
  it('parses claude --version', async () => {
    await expect(setup().runner.claudeCodeVersion()).resolves.toBe('2.1.283');
    expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseClaudeVersion('Claude Code')).toBeUndefined();
  });

  it('rejects with spawn_failed when the version cannot be read', async () => {
    await expect(setup({ version: 'garbage' }).runner.claudeCodeVersion()).rejects.toMatchObject({
      reason: 'spawn_failed',
    });
    await expect(
      setup({ executable: '/nonexistent/claude' }).runner.claudeCodeVersion(),
    ).rejects.toMatchObject({ reason: 'spawn_failed' });
  });
});
