// Test helpers: the committed fixtures, parsed. Imported by tests only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Results, ReviewSession } from '@placebo-eval/core/results';

export function fixtureText(name: 'rich' | 'minimal' | 'review'): string {
  return readFileSync(join(import.meta.dirname, '../../fixtures', `${name}.json`), 'utf8');
}

export function fixture(name: 'rich' | 'minimal'): Results {
  return JSON.parse(fixtureText(name)) as Results;
}

/** The review session `placebo review` would serve for the rich experiment. */
export function reviewFixture(): ReviewSession {
  return JSON.parse(fixtureText('review')) as ReviewSession;
}
