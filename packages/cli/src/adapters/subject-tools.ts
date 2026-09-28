import type { RunRequest } from '@placebo-eval/core';

// What a subject run may use. One rule decides it: every unit of work the agent causes is
// measured, or it cannot happen. `docs/measurement.md` records the facts behind each entry,
// verified against Claude Code 2.1.283.

/**
 * Tools subject runs never get, each with the reason its effects escape the run folder or the
 * measurement. Removed through `disallowedTools`, so they are absent from the `system_init` tool
 * list the report shows.
 */
export const SUBJECT_DISALLOWED_TOOLS = {
  CronCreate: 'schedules prompts that fire later, outside the run',
  CronDelete: 'manages scheduled prompts, which subject runs cannot create',
  CronList: 'lists scheduled prompts, which subject runs cannot create',
  ScheduleWakeup: 'schedules a later wake-up of the session, outside the run',
  Monitor: 'runs a background watcher that wakes the agent after the run would have ended',
  Workflow: 'fans out agents from a script, in the background',
  RemoteTrigger: 'creates and runs cloud-hosted routines, outside the machine',
  PushNotification: "sends notifications to the user's devices",
  SendMessage: 'messages other local and cloud sessions, and resumes subagents in the background',
  ListAgents: 'lists other local and cloud sessions, which are outside the run',
  EnterWorktree: 'creates git worktrees outside the run folder, from refs the snapshot seals away',
  ExitWorktree: 'manages git worktrees, which subject runs cannot create',
  DesignSync: "reads and writes the user's claude.ai design projects",
} as const satisfies Record<string, string>;

/**
 * Every other tool of Claude Code 2.1.283's subject tool list stays, with the reason its work is
 * measured. `Agent` (listed as `Task`) and `Bash` stay because background execution is off.
 */
export const SUBJECT_ALLOWED_TOOLS = {
  Task: 'the Agent tool: its subagent runs in the foreground and streams its events and usage',
  Bash: 'runs in the foreground, confined by the sandbox',
  Edit: 'edits files in the run folder',
  Write: 'writes files in the run folder',
  NotebookEdit: 'edits notebooks in the run folder',
  Read: 'reads files',
  Skill: "loads the project's skills, which are part of the configuration under test",
  ToolSearch: 'loads deferred tool schemas; only tools not disallowed can load',
  TaskCreate: "the session's own task list",
  TaskGet: "the session's own task list",
  TaskList: "the session's own task list",
  TaskUpdate: "the session's own task list",
  TaskStop: "stops the session's own tasks",
  ReportFindings: 'reports code-review findings in the transcript',
  WebFetch: 'fetches a URL; network stays allowed (brief §7)',
  WebSearch: 'searches the web; network stays allowed (brief §7)',
} as const satisfies Record<string, string>;

/** The `disallowedTools` of a subject run. */
export function subjectDisallowedTools(): string[] {
  return Object.keys(SUBJECT_DISALLOWED_TOOLS);
}

/**
 * Environment variables a request adds to the child's environment. A subject run without
 * `backgroundWork` sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, which removes
 * `run_in_background` from `Agent` and `Bash` and turns off auto-backgrounding; without it
 * `Agent` runs in the background by default and its work can outlive the run.
 */
export function subjectEnv(
  request: Pick<RunRequest, 'tools' | 'backgroundWork'>,
): Record<string, string> {
  return request.tools === 'subject' && request.backgroundWork !== true
    ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }
    : {};
}
