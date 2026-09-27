/**
 * Variables a parent Claude Code session sets for its own children. Placebo is often started
 * from inside Claude Code; passing these on makes the child refuse to start (`CLAUDECODE`,
 * `CLAUDE_CODE_ENTRYPOINT`) or tie itself to the parent session, and `CLAUDE_EFFORT` would carry
 * the parent's effort into every run, so a run's behaviour would depend on where Placebo was
 * launched from. Everything else, including auth and provider variables, passes through.
 */
export const PARENT_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const;

/** The environment for a Claude Code child: the given one minus the parent-session variables. */
export function childEnv(
  base: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const drop = new Set<string>(PARENT_SESSION_VARIABLES);
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !drop.has(key)) env[key] = value;
  }
  return env;
}
