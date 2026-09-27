import type { ResultEvent } from '../domain/events.js';
import { err, ok, type Result } from '../kernel/result.js';
import { RunnerInfraError, type RunRequest } from '../ports/runner.js';
import type { JudgeContext } from './context.js';

/** How a judge query is started (ADR 0007). */
export interface JudgeQuery {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /**
   * Opt-in. When set, the judge runs in this folder with read-only tools and no turn cap; by
   * default it runs one turn, tool-less, in a fresh empty directory.
   */
  readonly agenticCwd?: string;
}

/** A judge answer that passed validation, with the structured output verbatim. */
export interface JudgeAnswer<T> {
  readonly value: T;
  readonly raw: unknown;
}

/** Validates a judge's structured output; the error is a message for the grade detail. */
export type JudgeValidator<T> = (raw: unknown) => Result<T, string>;

/** The shape of a failed `safeParse`, without importing zod into graders. */
interface Issue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/** Formats schema issues as `path: message; ...`. */
export function issuesText(issues: readonly Issue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Builds the judge's `RunRequest`: no setting sources (no `CLAUDE.md`, no hooks, no project
 * settings, so neither arm's configuration reaches the judge), strict MCP config, no OS sandbox
 * (a tool-less or read-only judge needs none), no limits beyond one turn for the default judge.
 */
async function judgeRequest(ctx: JudgeContext, query: JudgeQuery): Promise<RunRequest> {
  const base = {
    prompt: query.prompt,
    model: ctx.judgeModel,
    settingSources: [],
    sandbox: false,
    strictMcpConfig: true,
    limits: {},
    outputSchema: query.outputSchema,
    systemPrompt: query.systemPrompt,
  } as const;
  if (query.agenticCwd !== undefined) {
    return { ...base, cwd: query.agenticCwd, tools: 'read_only' };
  }
  return { ...base, cwd: await ctx.createEmptyDir(), tools: 'none', maxTurns: 1 };
}

/**
 * Runs one judge query and validates its structured output. Returns an error message for
 * anything the judge got wrong (bad outcome, missing or invalid answer) and for a runner that
 * failed for another reason; rethrows `RunnerInfraError` so the caller can retry.
 */
export async function askJudge<T>(
  ctx: JudgeContext,
  query: JudgeQuery,
  validate: JudgeValidator<T>,
): Promise<Result<JudgeAnswer<T>, string>> {
  let result: ResultEvent;
  try {
    ({ result } = await ctx.runner.run(await judgeRequest(ctx, query), () => undefined));
  } catch (error) {
    if (error instanceof RunnerInfraError) throw error;
    return err(`judge could not run: ${messageOf(error)}`);
  }
  if (result.outcome !== 'completed') {
    return err(`judge run ended with outcome ${result.outcome}`);
  }
  const raw = result.structuredOutput;
  if (raw === undefined) return err('judge returned no structured output');
  const valid = validate(raw);
  if (!valid.ok) return err(`judge answer is invalid: ${valid.error}`);
  return ok({ value: valid.value, raw });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
