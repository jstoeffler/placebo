# Measurement: what Claude Code reports, and what Placebo does with it

Verified on 2026-09-28 against Claude Code 2.1.283 and `@anthropic-ai/claude-agent-sdk` 0.3.283, from three sources: the SDK's published type definitions (`sdk.d.ts`, `sdk-tools.d.ts`), the current Agent SDK and Claude Code documentation (code.claude.com, through Context7), and real runs on `claude-haiku-4-5-20251001` in a scratch folder with the options the SDK runner uses (project settings only, strict MCP config, sandbox on, permissions bypassed, partial messages on). Ten real runs, eight through `query()` and one through `claude -p --output-format stream-json`, cost $0.36 in all. The recordings that tests replay are in `packages/cli/src/adapters/*/fixtures/`.

## Why this matters

A dogfood run recorded a control run as 2 turns, 10.5 s and $0.08. The agent's only action had been an `Agent` call that started a background subagent; the parent ended its turn at once, the SDK's `result` message arrived, and the subagent kept editing the run folder for another four and a half minutes. Its edits were in the change, but its tokens, cost, turns, tool calls and transcript were not in the run: Placebo stopped reading the stream at the first `result` and took cost and duration from it.

## Facts

### Subagents stream through `query()`

- **Synchronous `Agent` calls** (verified): the subagent's assistant messages and its tool results arrive in the same stream, interleaved with the parent's, with `parent_tool_use_id` set to the id of the parent's `Agent` tool call. By default only `tool_use` and `tool_result` blocks are forwarded; `forwardSubagentText: true` adds the subagent's text and thinking blocks.
- **Background `Agent` calls** (verified): the same messages, same `parent_tool_use_id`, but they keep coming after the parent's `result`.
- **Subagent usage is provisional** (verified): subagent assistant messages carry the turn's input and cache token counts, which are final, but only the output tokens known when the first block streamed (3 or 4 in every recording). No `stream_event` (so no `message_delta` with the final usage) is emitted for subagent turns, even with `includePartialMessages` and `forwardSubagentText`. The final output tokens of subagent turns reach the stream only inside the result's `modelUsage` totals.
- System messages `task_started` (with `is_backgrounded`), `task_progress`, `task_updated` and `task_notification` (with `usage.total_tokens`, `tool_uses`, `duration_ms`) describe each subagent; `task_notification.usage.total_tokens` is a context size, not a sum of turns, so it cannot stand in for the subagent's tokens.
- The `Agent` tool is listed as `Task` in the init message's tool list and called as `Agent` in `tool_use` blocks.

### After the `result` message

- **SDK, string prompt** (verified): the first `result` arrives when the parent ends its turn (4.1 s in the recording), and the stream continues: subagent messages, a `task_notification` when the subagent finishes, then a second `system/init`, a new parent turn that reads the notification, and a second `result` with `origin: { kind: 'task-notification' }` and `result_index: 1`. The stream, and the promise, end only after it (36.6 s).
- **`claude -p`** (verified): the first `result` is held back until background work finishes, then both results are written together at the end. This is the documented "result held back while background work finishes".
- **What each result carries** (verified, and documented on the result type): `total_cost_usd` and `modelUsage` are cumulative for the whole `query()` call, main loop, subagents and internal calls included; "read the latest result rather than summing". `duration_api_ms` is cumulative too (13.4 s on both held-back results). `num_turns`, `duration_ms` and `usage` describe that result's own turn of the main loop only (2 turns and 4.1 s, then 1 turn and 1.9 s).
- In every recording the process waited for background subagents to finish before exiting. The type definitions say that on an interrupt a one-shot run kills held-back tasks; Placebo interrupts only on its own time limit or Ctrl-C.

### Turning background execution off

- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (documented under environment variables; verified): removes `run_in_background` from both `Bash` and `Agent`, turns off auto-backgrounding. An `Agent` call asked for `run_in_background: true` then ran in the foreground (`task_started.is_backgrounded: false`, `subagent_stats.requested.unset: 1`), and a `Bash` call could not be backgrounded because the parameter was gone. `Agent` runs in the background by default when the parameter is omitted (documented; the parameter's own description says so), so without this variable a subagent is background work unless the model opts out.
- `CLAUDE_CODE_DISABLE_CRON=1` removes `CronCreate`, `CronDelete` and `CronList`; `CLAUDE_CODE_DISABLE_WORKFLOWS=1` removes `Workflow` (verified by the init tool list). The same tools are removed by `disallowedTools` (verified), which is what Placebo uses, so one mechanism covers both runners.
- No setting or variable removes `Monitor`, `ScheduleWakeup`, `PushNotification`, `RemoteTrigger`, `SendMessage`, `ListAgents`, the worktree tools or `DesignSync`; `disallowedTools` removes each of them from the init tool list (verified).

### The tools of a subject run in this version

The init tool list, with project settings only and no MCP servers: `Task` (the `Agent` tool), `Bash`, `CronCreate`, `CronDelete`, `CronList`, `DesignSync`, `Edit`, `EnterWorktree`, `ExitWorktree`, `ListAgents`, `Monitor`, `NotebookEdit`, `PushNotification`, `Read`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`, `SendMessage`, `Skill`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskStop`, `TaskUpdate`, `ToolSearch`, `WebFetch`, `WebSearch`, `Workflow`, `Write`. Background- or scheduling-oriented, from their descriptions: `Agent` and `Bash` (with `run_in_background`), `Monitor` (a background watcher that wakes the model), `ScheduleWakeup` and the `Cron*` tools (later prompts in the same session), `Workflow` (scripts that fan out agents), `RemoteTrigger` (cloud-hosted routines), `SendMessage` (resumes a subagent in the background, or messages other local and cloud sessions) and `ListAgents` (lists those sessions). The decision for each is in `packages/cli/src/adapters/subject-tools.ts`.

### `modelUsage` prices every model

- Each `modelUsage` entry carries `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` and `costUSD` for one model (verified), plus `canonicalModel` and `costBasis: 'list'`.
- One cost cannot yield four rates, but Anthropic's list prices keep fixed ratios to the input rate for every current model: output 5×, cache read 0.1×, cache write 1.25× with the 5-minute TTL and 2× with the 1-hour TTL. With those ratios the recordings reproduce `costUSD` to the cent's millionth: the main loop wrote its cache with the 1-hour TTL (`result.usage.cache_creation.ephemeral_1h_input_tokens`) and subagents with the 5-minute one. For the synchronous recording, 996 in + 5 × 894 out + 0.1 × 64,407 cache read + 2 × 9,252 + 1.25 × 14,593 cache write = 48,651.95 input-token equivalents, at Haiku 4.5's $1 per million = $0.04865195, the reported `costUSD`.
- `modelUsage` also counts calls no streamed message shows: about 970 input tokens per run in every recording, from Claude Code's own helper calls.

## What Placebo does

One rule: every unit of work the agent causes is measured, or it cannot happen.

- **Background execution is off in subject runs.** The runners set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` unless the suite says `background_work: true`, which also raises the `background_work_unmeasured` warning. Judges never get background tools.
- **Tools whose effects escape the run folder or the measurement are disallowed in subject runs**, in both runners, through the `subject` tool mode. The effective tool list stays on the `system_init` event and the report shows it.
- **The stream is read to its end.** Messages after a `result` are translated like any other; the run's `result` event takes cost, API duration, denials and outcome from the last `result`, and sums `num_turns` over all of them.
- **Duration is wall clock**: `durationMs` runs from starting Claude Code to its exit; the sum of the results' own `duration_ms` is kept as `reportedDurationMs`.
- **Subagent work is attributed.** `assistant_text`, `tool_call`, `tool_result` and `usage` events carry `parentToolUseId` when a subagent produced them; tokens and tool calls count them, `turns` counts the main loop's turns and `subagentTurns` the subagents'.
- **Tokens add up to `modelUsage`.** What the last result's `modelUsage` counts beyond the streamed turns (the subagents' final output tokens and the helper calls) becomes one `usage` event marked `remainder`, so the run's tokens equal Claude Code's own totals.
- **Cost after the last result is estimated.** Usage streamed after the last `result` is priced at each model's rate derived from `modelUsage` with the ratios above and added; the result event keeps `reportedCostUsd` and sets `costEstimated`, and the report prints the cost with "≈".

## What stays unmeasurable

- Work that outlives the Claude Code process: none is possible with background execution off and the tools above disallowed; with `background_work: true`, a background task killed at exit leaves partial edits whose cost is known only up to the last streamed turn.
- Per-subagent output tokens: only the total over the run is exact (through the remainder), not its split between subagents.
- Cost of usage with no result at all (a crash before the first `result`): no rates exist to price it, so it stays zero, as before.
