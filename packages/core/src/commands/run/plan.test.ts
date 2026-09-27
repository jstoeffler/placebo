import { describe, expect, it } from 'vitest';
import { CONTROL, type Arm } from '../../domain/arm.js';
import type { ExperimentId, TaskId, VariantName } from '../../kernel/ids.js';
import { createSeededRandom } from '../../kernel/random.js';
import { planRuns, runPool } from './plan.js';

const RULES: Arm = {
  kind: 'treatment',
  variant: 'rules' as VariantName,
  patch: 'variants/rules.patch',
};

describe('planRuns', () => {
  const plan = (seed: number) =>
    planRuns({
      experimentId: 'exp' as ExperimentId,
      taskIds: ['a', 'b'] as TaskId[],
      arms: [CONTROL, RULES],
      runsPerTask: 2,
      random: createSeededRandom(seed),
    });

  it('plans every task × arm × run once, with readable run ids', () => {
    const ids = plan(1).map((slot) => slot.runId);
    expect([...ids].sort()).toEqual([
      'exp-a-control-1',
      'exp-a-control-2',
      'exp-a-rules-1',
      'exp-a-rules-2',
      'exp-b-control-1',
      'exp-b-control-2',
      'exp-b-rules-1',
      'exp-b-rules-2',
    ]);
  });

  it('shuffles by seed and gives each slot its own seed', () => {
    expect(plan(1)).toEqual(plan(1));
    expect(plan(1).map((slot) => slot.runId)).not.toEqual(plan(2).map((slot) => slot.runId));
    expect(new Set(plan(1).map((slot) => slot.seed)).size).toBe(8);
  });
});

describe('runPool', () => {
  it('stops taking items once work says stop, letting items in flight finish', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
      await new Promise((resolve) => setTimeout(resolve, item));
      return item === 2 ? 'stop' : 'continue';
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops when shouldStop turns true and handles no items', async () => {
    const seen: number[] = [];
    let stop = false;
    await runPool(
      [1, 2, 3],
      1,
      (item) => {
        seen.push(item);
        stop = true;
        return Promise.resolve('continue');
      },
      () => stop,
    );
    expect(seen).toEqual([1]);
    await expect(runPool([], 4, () => Promise.resolve('continue'))).resolves.toBeUndefined();
  });
});
