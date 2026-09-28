import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { ModelResolutionError, resolveModel } from './model-resolver.js';
import type { QueryFunction } from './sdk-runner/sdk-runner.js';

const init = (model: string) => ({
  type: 'system',
  subtype: 'init',
  model,
  claude_code_version: '2.1.283',
  tools: [],
});
const result = (cost: number, models: string[] = []) => ({
  type: 'result',
  subtype: 'success',
  total_cost_usd: cost,
  modelUsage: Object.fromEntries(models.map((model) => [model, { costUSD: cost }])),
});

function fakeQuery(messages: unknown[], calls: { prompt: string; options: Options }[] = []) {
  const query: QueryFunction = (params) => {
    calls.push(params);
    return (async function* () {
      for (const message of messages) {
        await Promise.resolve();
        if (message instanceof Error) throw message;
        yield message;
      }
    })();
  };
  return query;
}

describe('resolveModel', () => {
  it('asks one tool-less turn with no model option and reads the init message', async () => {
    const calls: { prompt: string; options: Options }[] = [];
    const resolved = await resolveModel({
      cwd: '/work/shop',
      env: { CLAUDECODE: '1', ANTHROPIC_API_KEY: 'key', CLAUDE_EFFORT: 'high' },
      query: fakeQuery([init('claude-sonnet-5'), result(0.0042, ['claude-sonnet-5'])], calls),
    });
    expect(resolved).toEqual({ model: 'claude-sonnet-5', costUsd: 0.0042 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.prompt.split(/\s+/)).toHaveLength(1);
    expect(call?.options).toEqual({
      cwd: '/work/shop',
      tools: [],
      maxTurns: 1,
      persistSession: false,
      env: { ANTHROPIC_API_KEY: 'key' },
    });
  });

  it('passes an alias as the model', async () => {
    const calls: { prompt: string; options: Options }[] = [];
    await resolveModel({
      cwd: '/w',
      alias: 'opus',
      env: {},
      query: fakeQuery([init('claude-opus-5-5'), result(0.01)], calls),
    });
    expect(calls[0]?.options.model).toBe('opus');
  });

  it('falls back to the models the result used when init names an alias', async () => {
    const resolved = await resolveModel({
      cwd: '/w',
      alias: 'opus',
      env: {},
      query: fakeQuery([init('opus'), result(0.01, ['claude-opus-5-5'])]),
    });
    expect(resolved.model).toBe('claude-opus-5-5');
  });

  it('keeps the model from init when the query fails after it', async () => {
    const resolved = await resolveModel({
      cwd: '/w',
      env: {},
      query: fakeQuery([init('claude-sonnet-5'), new Error('max turns')]),
    });
    expect(resolved).toEqual({ model: 'claude-sonnet-5', costUsd: undefined });
  });

  it('fails with what Claude Code said when it cannot start or answer', async () => {
    await expect(
      resolveModel({ cwd: '/w', env: {}, query: fakeQuery([new Error('Invalid API key')]) }),
    ).rejects.toThrow(new ModelResolutionError('Invalid API key'));
    await expect(
      resolveModel({ cwd: '/w', env: {}, query: fakeQuery([init('sonnet'), result(0)]) }),
    ).rejects.toThrow('Claude Code did not report a full model ID (it said "sonnet")');
    await expect(resolveModel({ cwd: '/w', env: {}, query: fakeQuery([]) })).rejects.toThrow(
      'Claude Code did not report a full model ID',
    );
  });
});
