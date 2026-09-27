import type { Change } from '../domain/change.js';
import type { CommitSha } from '../kernel/ids.js';

export interface Snapshot {
  /** Cache key: derived from the commit and the setup command hash. */
  readonly id: string;
  readonly path: string;
  /** The pinned commit resolved to its full id. */
  readonly commit: CommitSha;
}

/**
 * How a run folder was copied from its snapshot: `clonefile` is `cp -Rc` on macOS (APFS clones),
 * `reflink_auto` is `cp -a --reflink=auto` on Linux (a clone on Btrfs or XFS, a full copy on
 * ext4), `node_copy` is the full-copy fallback `fs.cp`.
 */
export type CopyMethod = 'clonefile' | 'reflink_auto' | 'node_copy';

export interface RunFolder {
  readonly path: string;
  readonly snapshotId: string;
  /** How the snapshot was copied; absent when the executor does not know. */
  readonly copyMethod?: CopyMethod;
}

export interface ExecResult {
  /** Null when the process was killed by a signal. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface HiddenFile {
  /** Destination, relative to the run folder. */
  readonly path: string;
  readonly content: string | Uint8Array;
}

/**
 * Prepares snapshots and run folders (implementations: local now, Docker later).
 *
 * Contract:
 * - `prepareSnapshot` makes a clean clone of `commit` from `repo` with no other commit or ref
 *   reachable, deletes `.placebo/` (ADR 0011), runs `setup` once, and caches the result by
 *   commit and setup-command hash. Untracked and ignored files of the working tree never enter.
 * - `createRunFolder` copies the snapshot (copy-on-write where the filesystem supports it),
 *   applies the variant patch if given, then amends it into the single commit so the run folder
 *   has exactly one commit with the original message and dates (ADR 0012). The control arm goes
 *   through the same amend with no patch. The folder it returns says how it was copied.
 * - `computeChange` is `git diff HEAD` plus untracked files: the agent's work only, never the
 *   variant's own files.
 * - `injectHidden` writes hidden files after the agent finished, before graders run.
 * - `exec` runs a shell command in the run folder with no time limit (ADR 0008).
 * - `createJudgeFolder` gives a judge somewhere to run (ADR 0007). With no argument it is a fresh
 *   empty directory under the executor's folders root. With a run folder it is a copy of it (the
 *   same copy-on-write path as `createRunFolder`) with every configuration-surface path removed:
 *   `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/` and `.mcp.json` at the root, every
 *   nested `CLAUDE.md` and `AGENTS.md` that is tracked or untracked (ignored ones stay), and every
 *   `.claude/` directory at any depth. Everything else stays, the agent's change and the single
 *   commit included.
 * - `remove` deletes a run folder or a judge folder; `listRunFolders` lists run folders only.
 */
export interface Executor {
  prepareSnapshot(input: {
    readonly repo: string;
    readonly commit: string;
    readonly setup?: string;
  }): Promise<Snapshot>;
  /** `patch` is the variant patch content; omitted for the control arm. */
  createRunFolder(snapshot: Snapshot, patch?: string): Promise<RunFolder>;
  computeChange(runFolder: RunFolder): Promise<Change>;
  injectHidden(runFolder: RunFolder, files: readonly HiddenFile[]): Promise<void>;
  exec(runFolder: RunFolder, command: string): Promise<ExecResult>;
  /** Omit `runFolder` for an empty directory; pass one for its config-stripped copy. */
  createJudgeFolder(runFolder?: RunFolder): Promise<RunFolder>;
  remove(runFolder: RunFolder): Promise<void>;
  listRunFolders(): Promise<RunFolder[]>;
}
