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

/** What one judge call cost. */
interface JudgeCall {
  readonly costUsd: number;
  readonly tokens: TokenUsage;
}

/** A judge answer that passed validation, with the structured output verbatim and its cost. */
interface JudgeAnswer<T> extends JudgeCall {
  readonly value: T;
  readonly raw: unknown;
}

/** A judge call that produced no valid answer; `call` is its cost when the runner returned. */
interface JudgeFailure {
  readonly message: string;
  readonly call?: JudgeCall;
}

/** The spend of a judge grade: the sum over its calls. */
function spendOf(calls: readonly JudgeCall[]): JudgeSpend {
  const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUsd = 0;
  for (const call of calls) {
    costUsd += call.costUsd;
    tokens.input += call.tokens.input;
    tokens.output += call.tokens.output;
    tokens.cacheRead += call.tokens.cacheRead;
    tokens.cacheWrite += call.tokens.cacheWrite;
  }
  return { costUsd, tokens, calls: calls.length };
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
async function inJudgeFolder<T>(
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
 * Runs one judge query in `folder` and validates its structured output. Returns a failure for
 * anything the judge got wrong (bad outcome, missing or invalid answer), with the call's cost,
 * and for a runner that failed for another reason; rethrows `RunnerInfraError` so the caller can
 * retry.
 */
async function askJudge<T>(
  ctx: JudgeContext,
  query: JudgeQuery,
  folder: RunFolder,
  validate: JudgeValidator<T>,
): Promise<Result<JudgeAnswer<T>, JudgeFailure>> {
  let result: ResultEvent;
  let tokens: TokenUsage;
  try {
    ({ result, usage: tokens } = await ctx.runner.run(
      judgeRequest(ctx, query, folder),
      () => undefined,
    ));
  } catch (error) {
    if (error instanceof RunnerInfraError) throw error;
    return err({ message: `judge could not run: ${messageOf(error)}` });
  }
  const call: JudgeCall = { costUsd: result.costUsd, tokens };
  if (result.outcome !== 'completed') {
    return err({ message: `judge run ended with outcome ${result.outcome}`, call });
  }
  const raw = result.structuredOutput;
  if (raw === undefined) return err({ message: 'judge returned no structured output', call });
  const valid = validate(raw);
  if (!valid.ok) return err({ message: `judge answer is invalid: ${valid.error}`, call });
  return ok({ value: valid.value, raw, ...call });
}

/** Every repeat's answer and their spend, or why a repeat failed and what was spent until then. */
type JudgeRepeats<T> = Result<
  { readonly answers: JudgeAnswer<T>[]; readonly spend: JudgeSpend },
  { readonly message: string; readonly spend?: JudgeSpend }
>;

/**
 * Asks `query` `repeats` times in one judge folder (see `inJudgeFolder`), stopping at the first
 * repeat that fails. The failure keeps the spend of every call that returned, the failing one
 * included; `RunnerInfraError` propagates.
 */
export async function askRepeats<T>(
  ctx: JudgeContext,
  query: JudgeQuery,
  source: RunFolder | undefined,
  validate: JudgeValidator<T>,
  repeats: number,
): Promise<JudgeRepeats<T>> {
  const answers: JudgeAnswer<T>[] = [];
  const calls: JudgeCall[] = [];
  const asked = await inJudgeFolder(ctx, source, async (folder) => {
    for (let repeat = 1; repeat <= repeats; repeat++) {
      const answer = await askJudge(ctx, query, folder, validate);
      if (!answer.ok) {
        if (answer.error.call !== undefined) calls.push(answer.error.call);
        const which = repeats > 1 ? ` (repeat ${String(repeat)} of ${String(repeats)})` : '';
        return `${answer.error.message}${which}`;
      }
      answers.push(answer.value);
      calls.push(answer.value);
    }
    return undefined;
  });
  const failure = asked.ok ? asked.value : asked.error;
  if (failure === undefined) return ok({ answers, spend: spendOf(calls) });
  return err({ message: failure, ...(calls.length === 0 ? {} : { spend: spendOf(calls) }) });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
