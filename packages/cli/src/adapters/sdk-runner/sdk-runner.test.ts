import { readFileSync } from 'node:fs';
import { type RunnerEvent, RunnerInfraError } from '@placebo-eval/core';
import { describe, expect, it } from 'vitest';
import { childEnv, PARENT_SESSION_VARIABLES } from './env.js';
import { bundledClaudeCodeVersion, SdkRunner } from './sdk-runner.js';
import { outcomeOf, parseRetryAfterMs, StreamProtocolError } from './stream.js';
import {
  fakeQuery,
  JUDGE_REQUEST,
  JUDGE_SCHEMA,
  READ_ONLY_JUDGE_REQUEST,
  sdkMessages,
  steppingClock,
  SUBJECT_REQUEST,
  withoutResult,
  withResult,
} from './test-support.js';

const PARENT_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/user',
  ANTHROPIC_API_KEY: 'sk-test',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ID: 'parent',
  CLAUDE_EFFORT: 'medium',
};

async function runWith(
  messages: readonly unknown[],
  request = SUBJECT_REQUEST,
  options: Parameters<typeof fakeQuery>[1] = {},
) {
  const fake = fakeQuery(messages, options);
  const runner = new SdkRunner({ query: fake.query, clock: steppingClock(), env: PARENT_ENV });
  const events: RunnerEvent[] = [];
  const result = await runner.run(request, (event) => events.push(event));
  const call = fake.calls[0];
  if (call === undefined) throw new Error('query was not called');
  return { result, events, options: call.options, prompt: call.prompt };
}

describe('SdkRunner options', () => {
  it('maps a subject run to the SDK options', async () => {
    const { options, prompt } = await runWith(sdkMessages('subject'));
    expect(prompt).toBe(SUBJECT_REQUEST.prompt);
    expect(options).toEqual({
      cwd: '/tmp/placebo-smoke',
      model: 'claude-haiku-4-5-20251001',
      settingSources: ['project'],
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      env: { PATH: '/usr/bin', HOME: '/home/user', ANTHROPIC_API_KEY: 'sk-test' },
      includePartialMessages: true,
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
    });
  });

  it('adds no limit, tool, output or abort keys the request does not carry (ADR 0008)', async () => {
    const { options } = await runWith(sdkMessages('subject'), {
      ...SUBJECT_REQUEST,
      sandbox: false,
    });
    for (const key of [
      'maxTurns',
      'maxBudgetUsd',
      'abortController',
      'fallbackModel',
      'outputFormat',
      'tools',
      'allowedTools',
      'disallowedTools',
      'sandbox',
    ]) {
      expect(options).not.toHaveProperty(key);
    }
  });

  it('never passes the parent session variables to the child', async () => {
    const { options } = await runWith(sdkMessages('subject'));
    for (const name of PARENT_SESSION_VARIABLES) expect(options.env).not.toHaveProperty(name);
    expect(options.env).toHaveProperty('ANTHROPIC_API_KEY', 'sk-test');
  });

  it('maps a tool-less judge: no tools, one turn, schema, appended system prompt, no settings', async () => {
    const { options } = await runWith(sdkMessages('judge'), JUDGE_REQUEST);
    expect(options).toMatchObject({
      settingSources: [],
      tools: [],
      disallowedTools: ['mcp__*'],
      maxTurns: 1,
      outputFormat: { type: 'json_schema', schema: JUDGE_SCHEMA },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are a judge.' },
    });
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('sandbox');
  });

  it('maps a read-only judge to exactly Read, Glob and Grep', async () => {
    const { options } = await runWith(sdkMessages('read-only-judge'), READ_ONLY_JUDGE_REQUEST);
    expect(options).toMatchObject({
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['mcp__*'],
      maxTurns: 10,
    });
  });

  it('takes turn and budget limits from the suite, with the request maxTurns winning', async () => {
    const limits = { maxTurns: 30, maxBudgetUsd: 2.5 };
    const fromSuite = await runWith(sdkMessages('subject'), { ...SUBJECT_REQUEST, limits });
    expect(fromSuite.options).toMatchObject({ maxTurns: 30, maxBudgetUsd: 2.5 });
    const overridden = await runWith(sdkMessages('subject'), {
      ...SUBJECT_REQUEST,
      limits,
      maxTurns: 3,
    });
    expect(overridden.options.maxTurns).toBe(3);
  });
});

describe('SdkRunner translation of recorded runs', () => {
  it('translates the recorded subject run', async () => {
    const { events, result } = await runWith(sdkMessages('subject'));
    expect(events.map((event) => event.type)).toEqual([
      'system_init',
      'tool_call',
      'usage',
      'tool_result',
      'tool_call',
      'tool_result',
      'usage',
      'assistant_text',
      'usage',
      'result',
    ]);
    expect(events[0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      claudeCodeVersion: '2.1.283',
    });
    expect(events[1]).toMatchObject({
      name: 'Read',
      input: { file_path: '/tmp/placebo-smoke/hello.txt' },
    });
    expect(result.result).toMatchObject({
      outcome: 'completed',
      turns: 3,
      stopReason: 'end_turn',
      permissionDenials: [],
    });
    expect(result.result).not.toHaveProperty('structuredOutput');
  });

  it('sums per-turn usage to the main-loop usage the result reports', async () => {
    for (const scenario of ['subject', 'judge', 'read-only-judge', 'max-turns'] as const) {
      const messages = sdkMessages(scenario);
      const raw = messages.find((message) => message.type === 'result')?.usage as Record<
        string,
        number
      >;
      const { result } = await runWith(messages);
      expect(result.usage).toEqual({
        input: raw.input_tokens,
        output: raw.output_tokens,
        cacheRead: raw.cache_read_input_tokens,
        cacheWrite: raw.cache_creation_input_tokens,
      });
    }
  });

  it('carries the structured output of a judge', async () => {
    const { result, events } = await runWith(sdkMessages('judge'), JUDGE_REQUEST);
    expect(events[0]).toMatchObject({ tools: ['StructuredOutput'] });
    expect(result.result.structuredOutput).toEqual({
      first_line_says_hi: true,
      rest_unchanged: true,
    });
  });

  it('maps the recorded max-turns run to failed', async () => {
    const { result } = await runWith(sdkMessages('max-turns'));
    expect(result.result.outcome).toBe('failed');
  });

  it('turns tool_result content blocks into text', async () => {
    const messages = sdkMessages('subject');
    const init = messages[0];
    const { events } = await runWith([
      init,
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'line' }, { type: 'image' }],
              is_error: true,
            },
            { type: 'tool_result', tool_use_id: 'toolu_2' },
            { type: 'text', text: 'not a tool result' },
          ],
        },
      },
      { type: 'user', message: { role: 'user', content: 'plain prompt echo' } },
      ...messages.filter((message) => message.type === 'result'),
    ]);
    expect(events.filter((event) => event.type === 'tool_result')).toEqual([
      expect.objectContaining({ id: 'toolu_1', output: 'line\n[image]', isError: true }),
      expect.objectContaining({ id: 'toolu_2', output: '', isError: false }),
    ]);
  });

  it('reads Claude Code usage from assistant messages when no message_delta arrives', async () => {
    const messages = sdkMessages('subject').filter((message) => message.type !== 'stream_event');
    const { result } = await runWith(messages);
    expect(result.usage.input).toBe(26);
    expect(result.usage.output).toBeGreaterThan(0);
  });

  it('ignores messages before system init and after the result', async () => {
    const messages = sdkMessages('subject');
    const { events } = await runWith([
      { type: 'rate_limit_event', rate_limit_info: {} },
      { type: 'assistant', not: 'parsed' },
      ...messages,
      { type: 'assistant', after: 'result' },
    ]);
    expect(events[0]?.type).toBe('system_init');
    expect(events.at(-1)?.type).toBe('result');
  });
});

describe('SdkRunner outcomes and infrastructure errors', () => {
  const subject = sdkMessages('subject');

  it('aborts after limits.maxDurationMs and records a failed run', async () => {
    const request = { ...SUBJECT_REQUEST, limits: { maxDurationMs: 20 } };
    const { options, result, events } = await runWith(
      withoutResult(sdkMessages('timeout')),
      request,
      {
        hang: true,
      },
    );
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(result.result).toMatchObject({ outcome: 'failed', costUsd: 0, stopReason: null });
    expect(events.at(-1)).toEqual(result.result);
  });

  it('keeps the result the SDK yielded before a timeout abort, as failed', async () => {
    const request = { ...SUBJECT_REQUEST, limits: { maxDurationMs: 20 } };
    const fake = fakeQuery(subject.slice(0, -1), { hang: true });
    const runner = new SdkRunner({ query: fake.query, clock: steppingClock() });
    const result = await runner.run(request, () => undefined);
    expect(result.result.outcome).toBe('failed');
  });

  it('aborts the query when request.signal fires and records a failed run', async () => {
    const controller = new AbortController();
    const fake = fakeQuery(withoutResult(sdkMessages('timeout')), { hang: true });
    const runner = new SdkRunner({ query: fake.query, clock: steppingClock() });
    const events: RunnerEvent[] = [];
    const running = runner.run({ ...SUBJECT_REQUEST, signal: controller.signal }, (event) =>
      events.push(event),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await running;
    expect(fake.calls[0]?.options.abortController?.signal.aborted).toBe(true);
    expect(result.result).toMatchObject({ outcome: 'failed', costUsd: 0, stopReason: null });
    expect(events.at(-1)).toEqual(result.result);
  });

  it('rejects with the signal reason when aborted before Claude Code started', async () => {
    const early = new AbortController();
    early.abort(new Error('stopped early'));
    const idle = fakeQuery([]);
    await expect(
      new SdkRunner({ query: idle.query }).run(
        { ...SUBJECT_REQUEST, signal: early.signal },
        () => undefined,
      ),
    ).rejects.toThrow('stopped early');
    expect(idle.calls).toHaveLength(0);

    const late = new AbortController();
    const hanging = fakeQuery([], { hang: true });
    const running = new SdkRunner({ query: hanging.query }).run(
      { ...SUBJECT_REQUEST, signal: late.signal },
      () => undefined,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    late.abort(new Error('stopped before init'));
    await expect(running).rejects.toThrow('stopped before init');
  });

  it('records a crash when the process dies after starting', async () => {
    const { result } = await runWith(withoutResult(subject), SUBJECT_REQUEST, {
      thenThrow: new Error('Claude Code process exited with code 1'),
    });
    expect(result.result).toMatchObject({ outcome: 'crashed', costUsd: 0, turns: 3 });
  });

  it('records a crash when the stream ends without a result', async () => {
    const { result } = await runWith(withoutResult(subject));
    expect(result.result.outcome).toBe('crashed');
  });

  it('keeps the error result when the SDK throws after yielding it', async () => {
    const messages = withResult(subject, {
      subtype: 'error_max_budget_usd',
      is_error: true,
      errors: ['budget'],
    });
    const { result } = await runWith(messages, SUBJECT_REQUEST, {
      thenThrow: new Error('Claude Code returned an error result'),
    });
    expect(result.result.outcome).toBe('failed');
  });

  it.each([
    ['spawn claude ENOENT', 'spawn_failed'],
    ['Claude Code native binary not found', 'spawn_failed'],
    ['API Error: 429 rate_limit_error, retry after 12 seconds', 'rate_limited'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['Invalid API key · Please run /login', 'auth'],
    ['Not logged in · Please run /login', 'auth'],
    ['API Error: 401 {"type":"authentication_error"}', 'auth'],
    ['API Error: 403 Forbidden', 'auth'],
    ['something odd', 'other'],
    [
      'Claude Code process exited with code 1: outputFormat.schema is not a valid JSON Schema',
      'invalid_request',
    ],
    ["Claude Code process exited with code 1: error: unknown option '--foo'", 'invalid_request'],
    ['Invalid option: permissionMode must be one of default, plan', 'invalid_request'],
  ])('rejects with a RunnerInfraError when %j is thrown before init', async (message, reason) => {
    const fake = fakeQuery([], { thenThrow: new Error(message) });
    const runner = new SdkRunner({ query: fake.query });
    await expect(runner.run(SUBJECT_REQUEST, () => undefined)).rejects.toMatchObject({
      name: 'RunnerInfraError',
      reason,
    });
    expect(fake.calls).toHaveLength(1);
  });

  it('records a crash, not a rejected request, when a started run dies with such a text', async () => {
    const { result } = await runWith(withoutResult(subject), SUBJECT_REQUEST, {
      thenThrow: new Error('Invalid schema in tool input'),
    });
    expect(result.result.outcome).toBe('crashed');
  });

  it('rejects with rate_limited and the retry hint when a started run hits a 429', async () => {
    const promise = runWith(
      [
        ...withoutResult(subject),
        {
          type: 'system',
          subtype: 'api_retry',
          retry_delay_ms: 8000,
          error_status: 429,
          error: 'rate_limit',
        },
      ],
      SUBJECT_REQUEST,
      { thenThrow: new Error('API Error: 429 Too Many Requests') },
    );
    await expect(promise).rejects.toMatchObject({ reason: 'rate_limited', retryAfterMs: 8000 });
  });

  it('rejects with network when a started run loses the connection', async () => {
    const promise = runWith(withoutResult(subject), SUBJECT_REQUEST, {
      thenThrow: new Error('socket hang up'),
    });
    await expect(promise).rejects.toMatchObject({ reason: 'network' });
  });

  it('rejects with rate_limited when the result is an API error with status 429 or 529', async () => {
    for (const status of [429, 529]) {
      const messages = withResult(subject, {
        is_error: true,
        api_error_status: status,
        result: 'API Error',
      });
      await expect(runWith(messages)).rejects.toMatchObject({ reason: 'rate_limited' });
    }
  });

  it('rejects with rate_limited when the last assistant message carries an overloaded error', async () => {
    const withError = subject.map((message) =>
      message.type === 'assistant' ? { ...message, error: 'overloaded' } : message,
    );
    const messages = withResult(withError, { is_error: true, result: 'API Error: 500' });
    await expect(runWith(messages)).rejects.toBeInstanceOf(RunnerInfraError);
  });

  it('rejects with auth when the result is an API error with status 401 or 403', async () => {
    for (const status of [401, 403]) {
      const messages = withResult(subject, {
        is_error: true,
        api_error_status: status,
        result: 'API Error',
      });
      await expect(runWith(messages)).rejects.toMatchObject({
        name: 'RunnerInfraError',
        reason: 'auth',
      });
    }
  });

  it.each([
    ['Invalid API key · Please run /login'],
    ['Credit balance is too low'],
    ['Your organization has insufficient quota; check your billing settings'],
  ])('rejects with auth when the error result says %j', async (text) => {
    const messages = withResult(subject, { is_error: true, result: text });
    await expect(runWith(messages)).rejects.toMatchObject({ reason: 'auth', message: text });
  });

  it.each(['authentication_failed', 'billing_error'])(
    'rejects with auth when the last assistant message carries a %s error',
    async (error) => {
      const withError = subject.map((message) =>
        message.type === 'assistant' ? { ...message, error } : message,
      );
      const messages = withResult(withError, { is_error: true, result: '' });
      await expect(runWith(messages)).rejects.toMatchObject({ reason: 'auth', message: error });
    },
  );

  it('records other API errors in a success result as a crash', async () => {
    const messages = withResult(subject, {
      is_error: true,
      api_error_status: 400,
      result: 'API Error: 400 invalid_request_error',
    });
    const { result } = await runWith(messages);
    expect(result.result.outcome).toBe('crashed');
  });

  it('rejects with network when an error_during_execution result says the connection failed', async () => {
    const messages = withResult(subject, {
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Connection error: ECONNRESET'],
    });
    await expect(runWith(messages)).rejects.toMatchObject({ reason: 'network' });
  });

  it('throws a StreamProtocolError, not an infra error, on a malformed known message', async () => {
    const promise = runWith([{ type: 'system', subtype: 'init', model: 42 }]);
    await expect(promise).rejects.toBeInstanceOf(StreamProtocolError);
  });
});

describe('outcomeOf', () => {
  const base = sdkMessages('subject').find((message) => message.type === 'result');
  const result = (fields: Record<string, unknown>) => ({ ...base, ...fields }) as never;
  const denial = { tool_name: 'Edit', tool_use_id: 'toolu_last', tool_input: {} };
  const context = { lastToolCallId: 'toolu_last', timedOut: false };

  it.each([
    [{ subtype: 'success' }, 'completed'],
    [{ subtype: 'success', is_error: true }, 'crashed'],
    [{ subtype: 'error_max_turns', is_error: true }, 'failed'],
    [{ subtype: 'error_max_budget_usd', is_error: true }, 'failed'],
    [{ subtype: 'error_max_structured_output_retries', is_error: true }, 'failed'],
    [{ subtype: 'error_during_execution', is_error: true }, 'crashed'],
    [{ subtype: 'success', permission_denials: [denial] }, 'stopped_by_permission_denial'],
    [
      { subtype: 'success', permission_denials: [{ ...denial, tool_use_id: 'toolu_earlier' }] },
      'completed',
    ],
    [
      {
        subtype: 'error_during_execution',
        terminal_reason: 'aborted_tools',
        permission_denials: [{ ...denial, tool_use_id: 'toolu_earlier' }],
      },
      'stopped_by_permission_denial',
    ],
    [{ subtype: 'error_max_turns', permission_denials: [denial] }, 'failed'],
  ])('maps %j to %s', (fields, outcome) => {
    expect(outcomeOf(result(fields), context)).toBe(outcome);
  });

  it('maps any run cut short by maxDurationMs to failed', () => {
    expect(outcomeOf(result({ subtype: 'success' }), { ...context, timedOut: true })).toBe(
      'failed',
    );
  });
});

describe('helpers', () => {
  it.each([
    ['retry-after: 30', 30_000],
    ['Please retry after 2.5 seconds', 2500],
    ['retry in 1500ms', 1500],
    ['no hint', undefined],
  ])('parses the retry hint in %j', (text, ms) => {
    expect(parseRetryAfterMs(text)).toBe(ms);
  });

  it('keeps every variable but the parent-session ones', () => {
    expect(childEnv({ ...PARENT_ENV, UNSET: undefined })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      ANTHROPIC_API_KEY: 'sk-test',
    });
  });

  it('reports the bundled Claude Code version, which the recorded init message confirms', async () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL('manifest.json', import.meta.resolve('@anthropic-ai/claude-agent-sdk')),
        'utf8',
      ),
    ) as { version: string };
    const version = await bundledClaudeCodeVersion();
    expect(version).toBe(manifest.version);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdkMessages('subject')[0]).toMatchObject({ claude_code_version: version });
    await expect(new SdkRunner().claudeCodeVersion()).resolves.toBe(version);
  });
});
