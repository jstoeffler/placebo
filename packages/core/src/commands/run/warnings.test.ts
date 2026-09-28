import { describe, expect, it } from 'vitest';
import { CONTROL } from '../../domain/arm.js';
import type { Warning } from '../../domain/warnings.js';
import type { TaskId, VariantName } from '../../kernel/ids.js';
import { describeWarning, mergeWarnings, upfrontWarnings } from './warnings.js';

const patch = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;

describe('upfrontWarnings', () => {
  it('finds nothing for a clean suite with enough tasks', () => {
    expect(
      upfrontWarnings({
        suite: { model: 'claude-sonnet-5', judgeModel: 'claude-opus-5-5' },
        arms: [CONTROL, { kind: 'treatment', variant: 'rules' as VariantName, patch: 'p' }],
        taskCount: 5,
        patchText: () => patch('.claude/settings.json'),
      }),
    ).toEqual([]);
  });

  it('flags each variant patch touching files outside the configuration surface', () => {
    const texts: Record<string, string> = {
      'a.patch': patch('CLAUDE.md') + patch('src/app.ts'),
      'b.patch': patch('AGENTS.md'),
    };
    expect(
      upfrontWarnings({
        suite: { model: 'm', judgeModel: 'j' },
        arms: [
          CONTROL,
          { kind: 'treatment', variant: 'a' as VariantName, patch: 'a.patch' },
          { kind: 'treatment', variant: 'b' as VariantName, patch: 'b.patch' },
        ],
        taskCount: 7,
        patchText: (path) => texts[path] ?? '',
      }),
    ).toEqual([{ type: 'patch_outside_surface', variant: 'a', paths: ['src/app.ts'] }]);
  });

  it('warns that background work is unmeasured when the suite allows it', () => {
    expect(
      upfrontWarnings({
        suite: { model: 'm', judgeModel: 'j', backgroundWork: true },
        arms: [CONTROL],
        taskCount: 5,
        patchText: () => '',
      }),
    ).toEqual([{ type: 'background_work_unmeasured' }]);
  });
});

describe('describeWarning', () => {
  it.each<[Warning, string]>([
    [
      { type: 'background_work_unmeasured' },
      'background_work is on: work still running when Claude Code exits is not measured, and cost after its last result is estimated',
    ],
    [
      { type: 'few_tasks', taskCount: 1, threshold: 5 },
      'only 1 task (fewer than 5): results describe these tasks, not the repo in general',
    ],
    [
      { type: 'dead_task', taskId: 'refund' as TaskId },
      'task "refund" scored zero in every arm; it is left out of the verdicts',
    ],
    [
      { type: 'isolation_residual', sources: ['global_config', 'claude_ai_connectors'] },
      'configuration outside the project can still reach runs: global_config, claude_ai_connectors',
    ],
    [
      { type: 'ancestor_configuration', paths: ['/Users/ada/CLAUDE.md', '/Users/ada/.claude'] },
      'Claude Code loads configuration from above the run folders into every arm: /Users/ada/CLAUDE.md, /Users/ada/.claude',
    ],
  ])('describes %j', (warning, text) => {
    expect(describeWarning(warning)).toBe(text);
  });
});

describe('mergeWarnings', () => {
  it('prefers the computed few_tasks and judge warnings and keeps the rest once', () => {
    const outside: Warning = {
      type: 'patch_outside_surface',
      variant: 'a' as VariantName,
      paths: ['x'],
    };
    const merged = mergeWarnings(
      [
        { type: 'few_tasks', taskCount: 3, threshold: 5 },
        { type: 'judge_equals_subject', model: 'm' },
        outside,
        outside,
      ],
      [{ type: 'few_tasks', taskCount: 2, threshold: 5 }],
    );
    expect(merged).toEqual([
      { type: 'few_tasks', taskCount: 2, threshold: 5 },
      { type: 'judge_equals_subject', model: 'm' },
      outside,
    ]);
  });
});
