import { describe, expect, it } from 'vitest';
import { sampleChange } from '../testing/fixtures.js';
import { RunnerEvent } from './events.js';
import { Grade } from './grade.js';
import { deriveMeasurements, deriveOutcome } from './measure.js';
import { Measurements } from './measurements.js';

const T = '2026-09-27T10:00:00.000Z';

const call = (id: string, name: string, input: unknown): unknown => ({
  type: 'tool_call',
  timestamp: T,
  id,
  name,
  input,
});
const output = (id: string, text: string, isError = false): unknown => ({
  type: 'tool_result',
  timestamp: T,
  id,
  output: text,
  isError,
});
const usage = (input: number, out: number, cacheRead: number, cacheWrite: number): unknown => ({
  type: 'usage',
  timestamp: T,
  input,
  output: out,
  cacheRead,
  cacheWrite,
});

const result = {
  type: 'result',
  timestamp: T,
  outcome: 'failed',
  costUsd: 0.5,
  turns: 4,
  durationMs: 12_000,
  apiDurationMs: 9_000,
  stopReason: 'end_turn',
  permissionDenials: [],
};

const script = RunnerEvent.array().parse([
  {
    type: 'system_init',
    timestamp: T,
    model: 'm',
    claudeCodeVersion: '2.1.283',
    tools: ['Read'],
  },
  { type: 'assistant_text', timestamp: T, text: 'Looking' },
  call('1', 'Read', { file_path: 'src/a.ts' }),
  output('1', 'héllo'), // 6 UTF-8 bytes
  call('2', 'Read', { file_path: 'src/a.ts' }),
  output('2', 'abcd'),
  call('3', 'Read', { file_path: 'src/b.ts' }),
  output('3', 'no such file', true), // errors are not bytes read
  call('4', 'Grep', { pattern: 'x' }),
  output('4', 'src/a.ts:1: x'), // not a Read: not counted
  call('5', 'Glob', { pattern: '**' }),
  call('6', 'WebSearch', { query: 'q' }),
  call('7', 'Edit', { file_path: 'src/a.ts' }),
  call('8', 'Read', 'not an object'),
  call('9', 'Read', { file_path: 42 }),
  usage(100, 20, 1000, 50),
  usage(10, 2, 300, 0),
  result,
]);

describe('deriveMeasurements', () => {
  it('derives exact numbers from a scripted stream and the change', () => {
    const measurements = deriveMeasurements(script, sampleChange);
    expect(Measurements.parse(measurements)).toEqual({
      tokens: { input: 110, output: 22, cacheRead: 1300, cacheWrite: 50 },
      costUsd: 0.5,
      turns: 4,
      durationMs: 12_000,
      apiDurationMs: 9_000,
      toolCalls: { total: 9, byTool: { Read: 5, Grep: 1, Glob: 1, WebSearch: 1, Edit: 1 } },
      filesRead: 2,
      bytesRead: 10,
      searchCalls: 3,
      changeBytes: 39,
      filesTouched: 1,
    });
  });

  it('reports zeros when the stream has no result event', () => {
    const measurements = deriveMeasurements(script.slice(0, 2), {
      diff: '',
      files: [],
      bytes: 0,
    });
    expect(measurements).toEqual({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      turns: 0,
      durationMs: 0,
      apiDurationMs: 0,
      toolCalls: { total: 0, byTool: {} },
      filesRead: 0,
      bytesRead: 0,
      searchCalls: 0,
      changeBytes: 0,
      filesTouched: 0,
    });
  });
});

describe('deriveOutcome', () => {
  it('reads the result event', () => {
    expect(deriveOutcome(script)).toBe('failed');
  });

  it('treats a missing result as crashed', () => {
    expect(deriveOutcome([])).toBe('crashed');
  });
});

describe('GradeDetail additions', () => {
  it('accepts comparison and error details', () => {
    const comparison = {
      grader: { type: 'comparison', index: 3 },
      kind: 'judge',
      score: 1,
      detail: {
        type: 'comparison',
        opponentRunId: 'run-2',
        position: 'b',
        preferred: true,
        reason: 'b handles the edge case.',
        model: 'claude-opus-5-5',
        raw: [{ better: 'b', reason: 'b handles the edge case.' }],
      },
    };
    const error = {
      grader: { type: 'command', index: 0 },
      kind: 'deterministic',
      score: 0,
      passed: false,
      detail: { type: 'error', message: 'spawn sh ENOENT' },
    };
    expect(Grade.parse(comparison)).toEqual(comparison);
    expect(Grade.parse(error)).toEqual(error);
  });

  it('rejects a comparison position other than a or b', () => {
    const result = Grade.safeParse({
      grader: { type: 'comparison', index: 3 },
      kind: 'judge',
      score: 1,
      detail: {
        type: 'comparison',
        opponentRunId: 'run-2',
        position: 'c',
        preferred: true,
        reason: '',
        model: 'm',
        raw: [],
      },
    });
    expect(result.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'detail.position: Invalid option: expected one of "a"|"b"',
    ]);
  });
});
