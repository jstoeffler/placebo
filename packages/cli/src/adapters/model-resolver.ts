import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { childEnv } from './sdk-runner/env.js';
import { SystemInit } from './sdk-runner/messages.js';
import type { QueryFunction } from './sdk-runner/sdk-runner.js';

/** A full model ID as Claude Code resolved it, and what asking cost, when the SDK says. */
export interface ResolvedModel {
  readonly model: string;
  readonly costUsd: number | undefined;
}

const Result = z.looseObject({
  type: z.literal('result'),
  total_cost_usd: z.number().nonnegative().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

/** An error Claude Code reported instead of answering, e.g. no login. */
export class ModelResolutionError extends Error {
  override readonly name = 'ModelResolutionError';
}

/** An alias like `opus`, rather than a full model ID like `claude-opus-5-5`. */
function isAlias(model: string): boolean {
  return !model.startsWith('claude-');
}

/**
 * Asks Claude Code which full model ID it runs: one tool-less, one-turn query with a one-word
 * prompt, in `cwd` with the user's own settings, so without `alias` the user's default model
 * applies. The ID comes from the init message; if that is still an alias, from the models the
 * result reports usage for. Parent-session variables are removed from the environment, as for
 * runs.
 */
export async function resolveModel(input: {
  readonly cwd: string;
  readonly alias?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly query?: QueryFunction;
}): Promise<ResolvedModel> {
  const query = input.query ?? sdkQuery;
  let initModel: string | undefined;
  let costUsd: number | undefined;
  let usedModels: string[] = [];
  try {
    for await (const message of query({
      prompt: 'hi',
      options: {
        cwd: input.cwd,
        ...(input.alias === undefined ? {} : { model: input.alias }),
        tools: [],
        maxTurns: 1,
        persistSession: false,
        env: childEnv(input.env),
      },
    })) {
      const init = SystemInit.safeParse(message);
      if (init.success) initModel ??= init.data.model;
      const result = Result.safeParse(message);
      if (result.success) {
        costUsd = result.data.total_cost_usd;
        usedModels = Object.keys(result.data.modelUsage ?? {});
      }
    }
  } catch (error) {
    if (initModel === undefined || isAlias(initModel)) {
      throw new ModelResolutionError(error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }
  const model =
    initModel !== undefined && !isAlias(initModel)
      ? initModel
      : usedModels.find((used) => !isAlias(used));
  if (model === undefined) {
    throw new ModelResolutionError(
      `Claude Code did not report a full model ID${initModel === undefined ? '' : ` (it said "${initModel}")`}`,
    );
  }
  return { model, costUsd };
}
