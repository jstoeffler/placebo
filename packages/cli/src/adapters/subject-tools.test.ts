import { describe, expect, it } from 'vitest';
import { cliMessages, sdkMessages } from './sdk-runner/test-support.js';
import {
  SUBJECT_ALLOWED_TOOLS,
  SUBJECT_DISALLOWED_TOOLS,
  subjectDisallowedTools,
  subjectEnv,
} from './subject-tools.js';

type Message = Record<string, unknown>;

function initTools(messages: readonly Message[]): string[] {
  const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
  return init?.tools as string[];
}

describe('subject tools', () => {
  it('decides every tool Claude Code offers a run with all tools, once', () => {
    const offered = initTools(sdkMessages('subject'));
    const decided = [
      ...Object.keys(SUBJECT_ALLOWED_TOOLS),
      ...Object.keys(SUBJECT_DISALLOWED_TOOLS),
    ];
    expect(new Set(decided).size).toBe(decided.length);
    expect([...offered].sort()).toEqual([...decided].sort());
  });

  it('leaves exactly the allowed tools in recorded subject runs of both runners', () => {
    for (const messages of [sdkMessages('sync-subagent'), cliMessages('sync-subagent')]) {
      expect([...initTools(messages)].sort()).toEqual(Object.keys(SUBJECT_ALLOWED_TOOLS).sort());
    }
  });

  it('disallows the tools whose effects escape the run', () => {
    expect(subjectDisallowedTools()).toEqual(Object.keys(SUBJECT_DISALLOWED_TOOLS));
    expect(subjectDisallowedTools()).toEqual(
      expect.arrayContaining(['Monitor', 'Workflow', 'CronCreate', 'RemoteTrigger', 'SendMessage']),
    );
  });
});

describe('subjectEnv', () => {
  it('turns background execution off in subject runs unless background work is allowed', () => {
    expect(subjectEnv({ tools: 'subject' })).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
    expect(subjectEnv({ tools: 'subject', backgroundWork: false })).toEqual({
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    });
    expect(subjectEnv({ tools: 'subject', backgroundWork: true })).toEqual({});
  });

  it('adds nothing to other tool modes', () => {
    for (const tools of ['all', 'read_only', 'none'] as const)
      expect(subjectEnv({ tools })).toEqual({});
  });
});
