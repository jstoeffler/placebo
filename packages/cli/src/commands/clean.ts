import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, type Run, type RunFolder, type Snapshot } from '@placebo-eval/core';
import type { SqliteRunStore } from '../adapters/sqlite-store/sqlite-run-store.js';
import { createExecutor, openStore, workspaceOf } from '../composition.js';
import { EXIT, UsageError } from '../errors.js';
import type { Host, Io } from '../host.js';

export interface CleanFlags {
  readonly suite?: string;
  readonly experiment?: string;
  readonly snapshots?: boolean;
  readonly dryRun?: boolean;
}

/**
 * `placebo clean`: removes kept run folders from the data directory, those of one experiment
 * with `--experiment`, and snapshots too with `--snapshots` (of that experiment's commit only
 * when an experiment is named). Stored runs whose folder was removed forget it. `--dry-run` lists
 * what would go and changes nothing.
 */
export async function cleanCommand(flags: CleanFlags, io: Io, host: Host): Promise<number> {
  const workspace = await workspaceOf({
    cwd: host.cwd,
    env: host.env,
    home: host.home,
    ...(flags.suite === undefined ? {} : { suite: flags.suite }),
  });
  const executor = createExecutor(workspace, host.clock);
  const store = existsSync(workspace.storeDir) ? await openStore(workspace) : undefined;
  try {
    let folders = await executor.listRunFolders();
    let snapshots: Snapshot[] = flags.snapshots === true ? await executor.listSnapshots() : [];
    let runs: Run[] = store === undefined ? [] : await store.list();
    if (flags.experiment !== undefined) {
      const experiment = await store?.getExperiment(flags.experiment as Run['experimentId']);
      if (experiment === undefined) {
        throw new UsageError(`the run store has no experiment ${flags.experiment}`);
      }
      runs = runs.filter((run) => run.experimentId === experiment.id);
      const paths = new Set(runs.map((run) => run.runFolder));
      folders = folders.filter((folder) => paths.has(folder.path));
      snapshots = snapshots.filter((snapshot) => snapshot.commit === experiment.pins.commit);
    }

    const folderBytes = await Promise.all(folders.map((folder) => sizeOf(folder.path)));
    const snapshotBytes = await Promise.all(snapshots.map((snapshot) => sizeOf(snapshot.path)));
    const total = [...folderBytes, ...snapshotBytes].reduce((sum, bytes) => sum + bytes, 0);
    const summary = `${plural(folders.length, 'run folder')}${
      flags.snapshots === true ? ` and ${plural(snapshots.length, 'snapshot')}` : ''
    }, ${formatBytes(total)}`;

    if (flags.dryRun === true) {
      const listed = [
        ...folders.map((folder, i) => [folder.path, folderBytes[i] ?? 0] as const),
        ...snapshots.map((snapshot, i) => [snapshot.path, snapshotBytes[i] ?? 0] as const),
      ];
      for (const [path, bytes] of listed) io.stdout(`  ${path}  ${formatBytes(bytes)}\n`);
      io.stdout(`would remove ${summary}\n`);
      return EXIT.ok;
    }

    for (const folder of folders) await executor.remove(folder);
    if (snapshots.length > 0) {
      await executor.removeSnapshots(snapshots.map((snapshot) => snapshot.id));
    }
    const cleared = await forgetFolders(store, runs, folders);
    io.stdout(
      `removed ${summary}${sharesBlocks(folders) ? ' (copy-on-write clones may free less)' : ''}\n`,
    );
    if (cleared > 0)
      io.stdout(`${plural(cleared, 'stored run')} no longer point at a run folder\n`);
    return EXIT.ok;
  } finally {
    store?.close();
  }
}

/** Saves every run whose folder was removed without its `runFolder`; returns how many. */
async function forgetFolders(
  store: SqliteRunStore | undefined,
  runs: readonly Run[],
  removed: readonly RunFolder[],
): Promise<number> {
  if (store === undefined) return 0;
  const paths = new Set(removed.map((folder) => folder.path));
  let count = 0;
  for (const run of runs) {
    if (run.runFolder === undefined || !paths.has(run.runFolder)) continue;
    const kept: Run = { ...run };
    delete kept.runFolder;
    await store.save(kept);
    count += 1;
  }
  return count;
}

/** Whether any folder is a clone that shares blocks with its snapshot. */
function sharesBlocks(folders: readonly RunFolder[]): boolean {
  return folders.some(
    (folder) => folder.copyMethod === 'clonefile' || folder.copyMethod === 'reflink_auto',
  );
}

/** Bytes of every file under `path`, without following symbolic links. */
async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return 0;
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path).catch(() => []);
  let total = 0;
  for (const entry of entries) total += await sizeOf(join(path, entry));
  return total;
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`;
}
