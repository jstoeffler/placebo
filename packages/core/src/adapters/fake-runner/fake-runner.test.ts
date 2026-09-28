import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerEvent } from '../../domain/events.js';
import type { Clock } from '../../kernel/clock.js';
import { RunnerInfraError, type RunRequest } from '../../ports/runner.js';
import { FakeRunner, type FakePlan } from './fake-runner.js';

/** A clock that advances one second per call, so event order shows in timestamps. */
function tickingClock(): Clock {
  let t = Date.parse('2026-09-27T10:00:00.000Z');
  return {
    now: () => {
      const d = new Date(t);
      t += 1000;
      return d;
    },
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'placebo-fake-runner-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const request = (over: Partial<RunRequest> = {}): RunRequest => ({
  cwd,
  prompt: 'Fix it.',
  model: 'claude-sonnet-5',
  settingSources: ['project'],
  sandbox: true,
  strictMcpConfig: true,
  limits: {},
  tools: 'all',
  ...over,
});

async function collect(
  runner: FakeRunner,
  req: RunRequest,
): Promise<{ events: RunnerEvent[]; result: Awaited<ReturnType<FakeRunner['run']>> }> {
  const events: RunnerEvent[] = [];
  const result = await runner.run(req, (event) => events.push(event));
  return { events, result };
}

describe('FakeRunner', () => {
  it('emits system_init first and result last, with clock timestamps and valid shapes', async () => {
    const runner = new FakeRunner({
      clock: tickingClock(),
      plan: () => FakeRunner.plans.editFile('src/a.ts', 'export const a = 1;\n'),
    });
    const { events, result } = await collect(runner, request());

    expect(RunnerEvent.array().parse(events)).toEqual(events);
    expect(events.map((e) => e.type)).toEqual([
      'system_init',
      'assistant_text',
      'tool_call',
      'tool_result',
      'usage',
      'tool_call',
      'tool_result',
      'usage',
      'assistant_text',
      'result',
    ]);
    expect(events[0]).toEqual({
      type: 'system_init',
      timestamp: '2026-09-27T10:00:00.000Z',
      model: 'claude-sonnet-5',
      claudeCodeVersion: '2.1.283',
      tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
    });
    expect(events.at(-1)).toBe(result.result);
    expect(result.result).toMatchObject({
      timestamp: '2026-09-27T10:00:09.000Z',
      outcome: 'completed',
      turns: 2,
      stopReason: 'end_turn',
    });
    expect(result.result).not.toHaveProperty('structuredOutput');
    expect(result.usage).toEqual({ input: 200, output: 40, cacheRead: 0, cacheWrite: 0 });
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.claudeCodeVersion).toBe('2.1.283');
    expect(await readFile(join(cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('plays a subagent call with nested steps under the call id', async () => {
    const plan: FakePlan = {
      steps: [
        { usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 } },
        {
          subagent: {
            input: { description: 'fix it', prompt: 'Fix a.ts.' },
            output: 'Fixed.',
            steps: [
              { tool: 'Read', input: { file_path: 'a.ts' }, output: 'x' },
              { usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
              { subagent: { steps: [{ text: 'deeper' }] } },
              { write: { path: 'a.ts', content: 'y' } },
            ],
          },
        },
      ],
      result: { costUsd: 0.2, durationMs: 5000, reportedDurationMs: 3000 },
    };
    const runner = new FakeRunner({ clock: tickingClock(), plan: () => plan });
    const { events, result } = await collect(runner, request({ tools: 'subject' }));

    expect(RunnerEvent.array().parse(events)).toEqual(events);
    expect(events[0]).toMatchObject({
      tools: ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
    });
    expect(
      events
        .slice(1, -1)
        .map((event) => [
          event.type,
          'parentToolUseId' in event ? event.parentToolUseId : undefined,
        ]),
    ).toEqual([
      ['usage', undefined],
      ['tool_call', undefined],
      ['tool_call', 'fake-tool-1'],
      ['tool_result', 'fake-tool-1'],
      ['usage', 'fake-tool-1'],
      ['tool_call', 'fake-tool-1'],
      ['assistant_text', 'fake-tool-3'],
      ['tool_result', 'fake-tool-1'],
      ['tool_result', undefined],
    ]);
    expect(events[2]).toMatchObject({ name: 'Agent', id: 'fake-tool-1' });
    expect(events.at(-2)).toMatchObject({ id: 'fake-tool-1', output: 'Fixed.' });
    expect(result.result).toMatchObject({
      turns: 1,
      costUsd: 0.2,
      reportedCostUsd: 0.2,
      costEstimated: false,
      durationMs: 5000,
      reportedDurationMs: 3000,
    });
    expect(result.usage).toEqual({ input: 15, output: 3, cacheRead: 0, cacheWrite: 0 });
    expect(await readFile(join(cwd, 'a.ts'), 'utf8')).toBe('y');
  });

  it('deletes files, honors scripted results and reports its version', async () => {
    await writeFile(join(cwd, 'old.txt'), 'x');
    const plan: FakePlan = {
      model: 'claude-other',
      steps: [
        { tool: 'Bash', input: { command: 'rm old.txt' }, output: 'denied', isError: true },
        { delete: 'old.txt' },
      ],
      result: {
        outcome: 'stopped_by_permission_denial',
        turns: 7,
        stopReason: null,
        permissionDenials: [{ tool: 'Bash', toolCallId: 'fake-tool-1', input: {} }],
      },
    };
    const runner = new FakeRunner({
      clock: tickingClock(),
      claudeCodeVersion: '9.9.9',
      plan: () => plan,
    });
    const { events, result } = await collect(runner, request({ tools: 'read_only' }));

    await expect(readFile(join(cwd, 'old.txt'))).rejects.toThrow();
    expect(events[0]).toMatchObject({ tools: ['Glob', 'Grep', 'Read'], model: 'claude-other' });
    expect(events[2]).toMatchObject({ type: 'tool_result', output: 'denied', isError: true });
    expect(result.result).toMatchObject({
      outcome: 'stopped_by_permission_denial',
      turns: 7,
      stopReason: null,
    });
    expect(await runner.claudeCodeVersion()).toBe('9.9.9');
  });

  it('answers judges with structured output and logs every request', async () => {
    const runner = new FakeRunner({
      clock: tickingClock(),
      plan: () => FakeRunner.plans.judgeAnswer({ answers: [] }),
    });
    const req = request({ tools: 'none', maxTurns: 1 });
    const { events, result } = await collect(runner, req);
    expect(events[0]).toMatchObject({ tools: [] });
    expect(result.result.structuredOutput).toEqual({ answers: [] });
    expect(result.result.turns).toBe(1);
    expect(runner.requests).toEqual([req]);
  });

  it('throws the scripted infra error before any event', async () => {
    const error = new RunnerInfraError('network', 'offline');
    const runner = new FakeRunner({ clock: tickingClock(), plan: () => ({ infraError: error }) });
    const events: RunnerEvent[] = [];
    await expect(runner.run(request(), (e) => events.push(e))).rejects.toBe(error);
    expect(events).toEqual([]);
    expect(runner.requests).toHaveLength(1);
  });

  it('fails the first n attempts per prompt, then succeeds', async () => {
    const runner = new FakeRunner({ clock: tickingClock(), plan: () => ({ failAttempts: 2 }) });
    const events: RunnerEvent[] = [];
    const onEvent = (e: RunnerEvent): void => {
      events.push(e);
    };
    await expect(runner.run(request(), onEvent)).rejects.toBeInstanceOf(RunnerInfraError);
    await expect(runner.run(request({ prompt: 'Other.' }), onEvent)).rejects.toThrow(
      'fake rate limit on attempt 1',
    );
    await expect(runner.run(request(), onEvent)).rejects.toThrow('fake rate limit on attempt 2');
    expect(events).toEqual([]);
    const ok = await runner.run(request(), onEvent);
    expect(ok.result.outcome).toBe('completed');
    expect(runner.requests).toHaveLength(4);
  });

  it('refuses paths outside the run folder', async () => {
    const runner = new FakeRunner({
      clock: tickingClock(),
      plan: () => ({ steps: [{ write: { path: '../escape.txt', content: 'x' } }] }),
    });
    await expect(runner.run(request(), () => undefined)).rejects.toThrow(
      'fake runner: path "../escape.txt" is outside the run folder',
    );
  });

  describe('signal', () => {
    it('rejects with the reason when aborted before the run starts', async () => {
      const runner = new FakeRunner({ clock: tickingClock(), plan: () => ({}) });
      const controller = new AbortController();
      controller.abort(new Error('stopped'));
      const events: RunnerEvent[] = [];
      await expect(
        runner.run(request({ signal: controller.signal }), (event) => events.push(event)),
      ).rejects.toThrow('stopped');
      expect(events).toEqual([]);
    });

    it('stops at the abort and resolves failed, skipping the remaining steps', async () => {
      const controller = new AbortController();
      const runner = new FakeRunner({
        clock: tickingClock(),
        plan: () => ({
          steps: [
            { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
            { wait: () => new Promise(() => undefined) },
            { write: { path: 'late.txt', content: 'x' } },
          ],
          result: { costUsd: 3 },
        }),
      });
      const events: RunnerEvent[] = [];
      const running = runner.run(request({ signal: controller.signal }), (event) =>
        events.push(event),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      const result = await running;
      expect(result.result).toMatchObject({ outcome: 'failed', costUsd: 0, turns: 1 });
      expect(events.map((event) => event.type)).toEqual(['system_init', 'usage', 'result']);
      await expect(readFile(join(cwd, 'late.txt'), 'utf8')).rejects.toThrow();
    });

    it('waits for a wait step to settle when never aborted', async () => {
      const controller = new AbortController();
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const runner = new FakeRunner({
        clock: tickingClock(),
        plan: () => ({ steps: [{ wait: () => gate }, { text: 'after' }] }),
      });
      const running = runner.run(request({ signal: controller.signal }), () => undefined);
      release();
      expect((await running).result.outcome).toBe('completed');
      const plain = new FakeRunner({
        clock: tickingClock(),
        plan: () => ({ steps: [{ wait: () => Promise.resolve() }] }),
      });
      expect((await plain.run(request(), () => undefined)).result.outcome).toBe('completed');
    });
  });
});
