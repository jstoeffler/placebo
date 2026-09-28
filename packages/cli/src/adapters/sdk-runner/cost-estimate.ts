import type { TokenUsage } from '@placebo-eval/core';
import type { ModelUsageEntry } from './messages.js';

// Prices usage Claude Code streamed but never costed: turns after its last result message.
// `modelUsage` gives one cost per model, not four rates, but Anthropic's list prices keep fixed
// ratios to the input rate for every current model, so one rate per model follows from it. The
// recorded runs reproduce `costUSD` exactly with these ratios (docs/measurement.md).

/** Tokens of one turn, with the part of `cacheWrite` written with the 1-hour TTL. */
export interface PricedTokens extends TokenUsage {
  readonly cacheWriteOneHour: number;
}

/** List price of each token kind, as a multiple of the input rate. */
const PRICE_RATIO = {
  input: 1,
  output: 5,
  cacheRead: 0.1,
  cacheWriteFiveMinutes: 1.25,
  cacheWriteOneHour: 2,
} as const;

/** The tokens in input-token equivalents. */
function inputEquivalents(tokens: PricedTokens): number {
  const oneHour = Math.min(tokens.cacheWriteOneHour, tokens.cacheWrite);
  return (
    tokens.input * PRICE_RATIO.input +
    tokens.output * PRICE_RATIO.output +
    tokens.cacheRead * PRICE_RATIO.cacheRead +
    (tokens.cacheWrite - oneHour) * PRICE_RATIO.cacheWriteFiveMinutes +
    oneHour * PRICE_RATIO.cacheWriteOneHour
  );
}

/**
 * USD per input-token equivalent for each model of `modelUsage`. `oneHourWrites` is, per model,
 * the 1-hour cache writes of the streamed turns `modelUsage` counts; writes it counts beyond those
 * (subagents, helper calls) used the 5-minute TTL in every recorded run.
 */
export function ratesFrom(
  modelUsage: Readonly<Record<string, ModelUsageEntry>>,
  oneHourWrites: ReadonlyMap<string, number>,
): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [model, entry] of Object.entries(modelUsage)) {
    const equivalents = inputEquivalents({
      input: entry.inputTokens,
      output: entry.outputTokens,
      cacheRead: entry.cacheReadInputTokens,
      cacheWrite: entry.cacheCreationInputTokens,
      cacheWriteOneHour: oneHourWrites.get(model) ?? 0,
    });
    if (equivalents > 0) rates.set(model, entry.costUSD / equivalents);
  }
  return rates;
}

/**
 * The estimated cost of `turns`, each at its model's rate. A turn whose model has no rate is
 * priced at `fallbackModel`'s, else at the highest rate known; with no rate at all it costs 0.
 */
export function estimateCostUsd(
  turns: readonly { readonly model: string | undefined; readonly tokens: PricedTokens }[],
  rates: ReadonlyMap<string, number>,
  fallbackModel: string,
): number {
  const fallback = rates.get(fallbackModel) ?? Math.max(0, ...rates.values());
  let cost = 0;
  for (const turn of turns) {
    const rate = (turn.model === undefined ? undefined : rates.get(turn.model)) ?? fallback;
    cost += rate * inputEquivalents(turn.tokens);
  }
  return cost;
}

/** The token totals of `modelUsage`, over every model. */
export function modelUsageTotals(
  modelUsage: Readonly<Record<string, ModelUsageEntry>>,
): TokenUsage {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of Object.values(modelUsage)) {
    totals.input += entry.inputTokens;
    totals.output += entry.outputTokens;
    totals.cacheRead += entry.cacheReadInputTokens;
    totals.cacheWrite += entry.cacheCreationInputTokens;
  }
  return totals;
}
