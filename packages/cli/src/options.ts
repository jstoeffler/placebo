import { InvalidArgumentError } from 'commander';
import { MAX_SEED, type KeepRunFolders } from '@placebo-eval/core';
import type { RunnerKind } from './composition.js';

/** A commander parser for an integer of at least `min`. */
function integer(min: number, max = Number.MAX_SAFE_INTEGER): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (
      !/^\d+$/.test(value.trim()) ||
      !Number.isSafeInteger(parsed) ||
      parsed < min ||
      parsed > max
    ) {
      throw new InvalidArgumentError(
        max === Number.MAX_SAFE_INTEGER
          ? `expected a whole number of at least ${String(min)}`
          : `expected a whole number from ${String(min)} to ${String(max)}`,
      );
    }
    return parsed;
  };
}

export const positiveInteger = integer(1);
export const seedValue = integer(0, MAX_SEED);

/** Collects a repeatable option into a list. */
export function collect(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function oneOf<T extends string>(choices: readonly T[], shown: readonly T[]): (value: string) => T {
  return (value) => {
    const found = choices.find((choice) => choice === value);
    if (found === undefined) {
      throw new InvalidArgumentError(`expected one of ${shown.join(', ')}`);
    }
    return found;
  };
}

export const keepPolicy = oneOf<KeepRunFolders>(
  ['all', 'reviewable', 'none'],
  ['all', 'reviewable', 'none'],
);
/** `fake` is accepted but not advertised: it is for demos and tests. */
export const runnerKind = oneOf<RunnerKind>(['sdk', 'cli', 'fake'], ['sdk', 'cli']);
