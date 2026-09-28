import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHECKLIST_JUDGE_OUTPUT_SCHEMA,
  COMPARISON_JUDGE_OUTPUT_SCHEMA,
  DEFAULT_SETTING_SOURCES,
  FakeRunner,
  type RunRequest,
  systemClock,
} from '@placebo-eval/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlan, namedFile } from './fake-plan.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'placebo-fake-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function request(prompt: string, extra: Partial<RunRequest> = {}): RunRequest {
  return {
    cwd,
    prompt,
    model: 'claude-sonnet-5',
    settingSources: DEFAULT_SETTING_SOURCES,
    sandbox: true,
    strictMcpConfig: true,
    limits: {},
    tools: 'all',
    ...extra,
  };
}

const runner = new FakeRunner({ clock: systemClock, plan: createFakePlan() });

describe('namedFile', () => {
  it.each([
    ['Add a file named PLACEBO.md at the repository root.', 'PLACEBO.md'],
    ['Create a module named `src/util/money.ts` please', 'src/util/money.ts'],
    ['Nothing to write here.', undefined],
    ['A file named /etc/passwd', undefined],
    ['A file named ../outside.txt', undefined],
  ])('reads %j as %s', (prompt, file) => {
    expect(namedFile(prompt)).toBe(file);
  });
});

describe('createFakePlan', () => {
  it('writes the named file and completes with usage and cost', async () => {
    const { result, usage } = await runner.run(
      request('Add a file named NOTES.md.'),
      () => undefined,
    );
    expect(await readFile(join(cwd, 'NOTES.md'), 'utf8')).toContain('fake runner');
    expect(result.outcome).toBe('completed');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(usage.input).toBeGreaterThan(0);
  });

  it('costs more with each configuration file in the run folder', async () => {
    const bare = await runner.run(request('Look around.'), () => undefined);
    await writeFile(join(cwd, 'CLAUDE.md'), 'rules');
    const configured = await runner.run(request('Look around.'), () => undefined);
    expect(configured.result.costUsd).toBeGreaterThan(bare.result.costUsd);
    expect(configured.usage.input).toBeGreaterThan(bare.usage.input);
  });

  it('answers a checklist judge once per question, yes when there is a change', async () => {
    const prompt = [
      '## Change',
      '```diff\ndiff --git a/x b/x\n```',
      '## Questions',
      'Answer every question, in this order, copying each question verbatim into `question`.',
      '',
      '1. Is it there?',
      '2. Is it short?',
    ].join('\n');
    const judged = await runner.run(
      request(prompt, { outputSchema: CHECKLIST_JUDGE_OUTPUT_SCHEMA, tools: 'none' }),
      () => undefined,
    );
    expect(judged.result.structuredOutput).toEqual({
      answers: [
        { question: 'Is it there?', yes: true, reason: 'The change addresses it.' },
        { question: 'Is it short?', yes: true, reason: 'The change addresses it.' },
      ],
    });
    const unchanged = await runner.run(
      request(prompt.replace('diff --git a/x b/x', 'No change'), {
        outputSchema: CHECKLIST_JUDGE_OUTPUT_SCHEMA,
      }),
      () => undefined,
    );
    expect(unchanged.result.structuredOutput).toMatchObject({
      answers: [{ yes: false }, { yes: false }],
    });
  });

  const compare = (judge: FakeRunner) => async (a: string, b: string) =>
    (
      await judge.run(
        request(`## Attempt a\n${a}\n\n## Attempt b\n${b}\n`, {
          outputSchema: COMPARISON_JUDGE_OUTPUT_SCHEMA,
        }),
        () => undefined,
      )
    ).result.structuredOutput as { better: 'a' | 'b' };

  it('prefers the attempt that adds more lines', async () => {
    const ask = compare(new FakeRunner({ clock: systemClock, plan: createFakePlan() }));
    expect(await ask('+one', '+one\n+two')).toMatchObject({ better: 'b' });
    expect(await ask('+one\n+two', '+one')).toMatchObject({ better: 'a' });
  });

  it('alternates ties so identical attempts split evenly', async () => {
    const ask = compare(new FakeRunner({ clock: systemClock, plan: createFakePlan() }));
    const picks: string[] = [];
    for (let i = 0; i < 10; i++) picks.push((await ask('+same', '+same')).better);
    expect(picks.filter((pick) => pick === 'a')).toHaveLength(5);
    expect(picks.slice(0, 4)).toEqual(['a', 'b', 'a', 'b']);
    // A decided comparison in between does not disturb the alternation.
    await ask('+one', '+one\n+two');
    expect((await ask('+same', '+same')).better).toBe('a');
  });
});
