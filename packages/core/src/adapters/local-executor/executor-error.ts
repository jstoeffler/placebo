export type ExecutorErrorReason =
  | 'commit_not_found'
  | 'clone_failed'
  | 'setup_failed'
  | 'patch_rejected'
  | 'patch_failed'
  | 'copy_failed'
  | 'git_failed'
  | 'path_escapes_run_folder';

/**
 * An infrastructure failure of the local executor. Never an agent outcome: every reason means the
 * snapshot or run folder could not be prepared as the contract requires.
 */
export class ExecutorError extends Error {
  override readonly name = 'ExecutorError';
  readonly reason: ExecutorErrorReason;
  /** Output of the failing command, when there was one. */
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    reason: ExecutorErrorReason,
    message: string,
    output: { readonly stdout?: string; readonly stderr?: string } = {},
  ) {
    super(message);
    this.reason = reason;
    this.stdout = output.stdout ?? '';
    this.stderr = output.stderr ?? '';
  }
}
