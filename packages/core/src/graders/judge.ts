import type { ResultEvent, TokenUsage } from '../domain/events.js';
import type { JudgeSpend } from '../domain/grade.js';
import { err, ok, type Result } from '../kernel/result.js';
import type { RunFolder } from '../ports/executor.js';
import { RunnerInfraError, type RunRequest } from '../ports/runner.js';
import type { JudgeContext } from './context.js';

/** How a judge query is started (ADR 0007). */
export interface JudgeQuery {
  readonly prompt: string;
  readonly systemPrompt: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  /**
   * Opt-in. When true, the judge explores its judge folder (a config-stripped copy of the run
   * folder) with read-only tools and no turn cap; by default it runs one turn, tool-less, in an
   * empty judge folder.
   */
  readonly agentic?: boolean;
}

/** A judge answer that passed validation, with the structured output verbatim and its cost. */
export interface JudgeAnswer<T> {
  readonly value: T;
  readonly raw: unknown;
  readonly costUsd: number;
  readonly tokens: TokenUsage;
}

/** The spend of a judge grade: the sum over its answers, one call each. */
export function spendOf(answers: readonly JudgeAnswer<unknown>[]): JudgeSpend {
  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  for (const answer of answers) {
    costUsd += answer.costUsd;
    tokens.input += answer.tokens.input;
    tokens.output += answer.tokens.output;
    tokens.cacheRead += answer.tokens.cacheRead;
    tokens.cacheWrite += answer.tokens.cacheWrite;
  }
  return { costUsd, tokens, calls: answers.length };
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
function judgeRequest(ctx: JudgeContext, query: JudgeQuery, folder: RunFolder): RunRequest {
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
  if (query.agentic === true) return { ...base, cwd: folder.path, tools: 'read_only' };
  return { ...base, cwd: folder.path, tools: 'none', maxTurns: 1 };
}

/**
 * Creates a judge folder (empty, or a config-stripped copy of `source`), hands it to `use`, and
 * removes it afterwards, also when `use` throws. A folder that cannot be created is an error
 * message for the grade detail.
 */
export async function inJudgeFolder<T>(
  ctx: JudgeContext,
  source: RunFolder | undefined,
  use: (folder: RunFolder) => Promise<T>,
): Promise<Result<T, string>> {
  let folder: RunFolder;
  try {
    folder = await ctx.executor.createJudgeFolder(source);
  } catch (error) {
    return err(`judge folder could not be created: ${messageOf(error)}`);
  }
  try {
    return ok(await use(folder));
  } finally {
    await ctx.executor.remove(folder);
  }
}

/**
 * Runs one judge query in `folder` and validates its structured output. Returns an error message for
 * anything the judge got wrong (bad outcome, missing or invalid answer) and for a runner that
 * failed for another reason; rethrows `RunnerInfraError` so the caller can retry.
 */
export async function askJudge<T>(
  ctx: JudgeContext,
  query: JudgeQuery,
  folder: RunFolder,
  validate: JudgeValidator<T>,
): Promise<Result<JudgeAnswer<T>, string>> {
  let result: ResultEvent;
  let tokens: TokenUsage;
  try {
    ({ result, usage: tokens } = await ctx.runner.run(
      judgeRequest(ctx, query, folder),
      () => undefined,
    ));
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
  return ok({ value: valid.value, raw, costUsd: result.costUsd, tokens });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
