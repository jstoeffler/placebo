import { describe, expect, it } from 'vitest';
import { readEmbedded } from './embedded.js';

describe('readEmbedded', () => {
  it('is absent without a tag or with an empty tag', () => {
    expect(readEmbedded(null)).toEqual({ state: 'absent' });
    expect(readEmbedded('  \n')).toEqual({ state: 'absent' });
  });

  it('loads version 1 results', () => {
    const embedded = readEmbedded('{"schemaVersion":1,"experiment":{"id":"exp-1"}}');
    expect(embedded.state).toBe('loaded');
  });

  it.each([
    ['{', 'embedded results are not valid JSON'],
    ['[]', 'embedded results have no schemaVersion'],
    ['null', 'embedded results have no schemaVersion'],
    ['{"schemaVersion":2}', 'unsupported schemaVersion 2'],
  ])('rejects %j', (text, reason) => {
    expect(readEmbedded(text)).toEqual({ state: 'invalid', reason });
  });
});
