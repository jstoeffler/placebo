import { describe, expect, it } from 'vitest';
import { judgeEqualsSubject } from './judge-equals-subject.js';
import { parseQuestions } from './questions.js';
import { transcriptOf } from './transcript.js';

const T = '2026-09-27T10:00:00.000Z';

describe('parseQuestions', () => {
  it('reads one question per list item and ignores everything else', () => {
    const markdown = [
      '# Checklist',
      '',
      '## Correctness',
      '- Rounds half up?  ',
      '* Keeps the signature?',
      '+ Adds a test?',
      '1. Numbered with a dot?',
      '  2) Numbered with a paren?',
      '- [ ] Unchecked box?',
      '- [x] Checked box?',
      'Plain prose.',
      '-no space is not an item',
      '- ',
      '\r',
    ].join('\r\n');
    expect(parseQuestions(markdown)).toEqual([
      'Rounds half up?',
      'Keeps the signature?',
      'Adds a test?',
      'Numbered with a dot?',
      'Numbered with a paren?',
      'Unchecked box?',
      'Checked box?',
    ]);
  });
});

describe('transcriptOf', () => {
  it('joins assistant text and tool calls, not tool results', () => {
    expect(
      transcriptOf([
        { type: 'assistant_text', timestamp: T, text: 'Looking.' },
        { type: 'tool_call', timestamp: T, id: '1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_result', timestamp: T, id: '1', output: 'secret', isError: false },
        { type: 'tool_call', timestamp: T, id: '2', name: 'Noop', input: undefined },
      ]),
    ).toBe('Looking.\nBash {"command":"ls"}\nNoop null');
  });
});

describe('judgeEqualsSubject', () => {
  it('warns when the judge model is the subject model', () => {
    expect(judgeEqualsSubject({ model: 'claude-sonnet-5', judgeModel: 'claude-sonnet-5' })).toEqual(
      {
        type: 'judge_equals_subject',
        model: 'claude-sonnet-5',
      },
    );
  });

  it('is silent when they differ', () => {
    expect(
      judgeEqualsSubject({ model: 'claude-sonnet-5', judgeModel: 'claude-opus-5-5' }),
    ).toBeUndefined();
  });
});
