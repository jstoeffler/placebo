import { describe, expect, it } from 'vitest';
import { estimateCostUsd, modelUsageTotals, ratesFrom } from './cost-estimate.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-5';

// The recorded synchronous-subagent run of docs/measurement.md: Haiku 4.5 at $1 per million
// input tokens, the main loop's 9,252 cache writes at the 1-hour TTL.
const RECORDED = {
  inputTokens: 996,
  outputTokens: 894,
  cacheReadInputTokens: 64_407,
  cacheCreationInputTokens: 23_845,
  costUSD: 0.04865195,
};

const turn = (model: string | undefined, over: Partial<Record<string, number>> = {}) => ({
  model,
  tokens: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWriteOneHour: 0,
    ...over,
  },
});

describe('ratesFrom', () => {
  it("recovers a model's input rate from its reported cost with the list price ratios", () => {
    const rates = ratesFrom({ [HAIKU]: RECORDED }, new Map([[HAIKU, 9_252]]));
    expect(rates.get(HAIKU)).toBeCloseTo(1e-6, 12);
  });

  it('prices every cache write at the 5-minute TTL when no streamed turn wrote for an hour', () => {
    const rates = ratesFrom({ [HAIKU]: RECORDED }, new Map());
    expect(rates.get(HAIKU)).toBeGreaterThan(1e-6);
  });

  it('skips a model with no tokens', () => {
    const empty = { ...RECORDED, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    expect(ratesFrom({ x: { ...empty, cacheCreationInputTokens: 0 } }, new Map()).size).toBe(0);
  });
});

describe('estimateCostUsd', () => {
  const rates = new Map([
    [HAIKU, 1e-6],
    [SONNET, 3e-6],
  ]);

  it('prices each turn at its own model and each token kind at its ratio', () => {
    const cost = estimateCostUsd(
      [
        turn(HAIKU, { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 2000 }),
        turn(SONNET, { input: 1000, cacheWrite: 1000, cacheWriteOneHour: 1000 }),
      ],
      rates,
      HAIKU,
    );
    // Haiku: 1000 + 500 + 1000 + 2500 = 5000 equivalents; Sonnet: 1000 + 2000 = 3000.
    expect(cost).toBeCloseTo(5000 * 1e-6 + 3000 * 3e-6, 12);
  });

  it("prices a turn of an unknown model at the main model's rate, else at the highest", () => {
    const unknown = [turn('claude-other', { input: 1000 })];
    expect(estimateCostUsd(unknown, rates, HAIKU)).toBeCloseTo(1e-3, 12);
    expect(estimateCostUsd(unknown, rates, 'claude-missing')).toBeCloseTo(3e-3, 12);
    expect(estimateCostUsd([turn(undefined, { input: 1000 })], rates, SONNET)).toBeCloseTo(
      3e-3,
      12,
    );
    expect(estimateCostUsd(unknown, new Map(), HAIKU)).toBe(0);
  });
});

describe('modelUsageTotals', () => {
  it('adds every model', () => {
    expect(modelUsageTotals({ [HAIKU]: RECORDED, [SONNET]: RECORDED })).toEqual({
      input: 1992,
      output: 1788,
      cacheRead: 128_814,
      cacheWrite: 47_690,
    });
  });
});
