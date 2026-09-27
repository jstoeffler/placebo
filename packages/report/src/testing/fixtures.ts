// Test helpers: the committed fixtures, parsed. Imported by tests only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Results } from '@placebo-eval/core/results';

export function fixtureText(name: 'rich' | 'minimal'): string {
  return readFileSync(join(import.meta.dirname, '../../fixtures', `${name}.json`), 'utf8');
}

export function fixture(name: 'rich' | 'minimal'): Results {
  return JSON.parse(fixtureText(name)) as Results;
}
