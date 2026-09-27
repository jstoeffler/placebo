import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  armName,
  Experiment,
  type ExperimentId,
  Review,
  Run,
  type RunFilter,
  type RunId,
  type RunStore,
} from '@placebo-eval/core';

/** Bump when the index tables change; an index at another version is rebuilt on open. */
const SCHEMA_VERSION = '1';
const INDEX_FILE = 'index.sqlite';
const EXPERIMENTS_DIR = 'experiments';
/** How long a write waits for another process holding the index lock. */
const BUSY_TIMEOUT_MS = 10_000;
/** Ids become file and folder names, so they must be plain path segments. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CREATE_TABLES = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    arm TEXT NOT NULL,
    started_at TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    variant_hash TEXT NOT NULL,
    commit_hash TEXT NOT NULL,
    subject_model TEXT NOT NULL,
    claude_code_version TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX runs_by_experiment ON runs (experiment_id, started_at);
  CREATE INDEX runs_by_key ON runs (task_hash, variant_hash, commit_hash, subject_model, claude_code_version);
  CREATE TABLE experiments (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, path TEXT NOT NULL);
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    experiment_id TEXT NOT NULL,
    path TEXT NOT NULL
  );
  CREATE INDEX reviews_by_run ON reviews (run_id);
`;

const DROP_TABLES = `
  DROP TABLE IF EXISTS meta;
  DROP TABLE IF EXISTS runs;
  DROP TABLE IF EXISTS experiments;
  DROP TABLE IF EXISTS reviews;
`;

const UPSERT_RUN = `INSERT OR REPLACE INTO runs
  (id, experiment_id, task_id, arm, started_at, task_hash, variant_hash, commit_hash, subject_model, claude_code_version, path)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_EXPERIMENT =
  'INSERT OR REPLACE INTO experiments (id, created_at, path) VALUES (?, ?, ?)';
const UPSERT_REVIEW =
  'INSERT OR REPLACE INTO reviews (id, run_id, experiment_id, path) VALUES (?, ?, ?, ?)';

/** A run store file that is missing, not JSON, or fails its domain schema. */
export class RunStoreFileError extends Error {
  override readonly name = 'RunStoreFileError';
  /** Absolute path of the file. */
  readonly path: string;

  constructor(path: string, detail: string, options?: ErrorOptions) {
    super(`run store file ${path}: ${detail}`, options);
    this.path = path;
  }
}

/** The run store root of a repo: `<repo>/.placebo/runs`. */
export function runStoreRoot(repoRoot: string): string {
  return join(repoRoot, '.placebo', 'runs');
}

interface Located<T> {
  readonly value: T;
  /** Relative to the run store root. */
  readonly path: string;
}

interface Contents {
  readonly experiments: Located<Experiment>[];
  readonly runs: Located<Run>[];
  readonly reviews: (Located<Review> & { readonly experimentId: string })[];
}

/** Anything with a Zod-like `safeParse`; keeps zod itself out of the cli's dependencies. */
interface Schema<T> {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

/**
 * The run store on disk (ADR 0010). One pretty-printed JSON file per experiment, run and review is
 * the source of truth:
 *
 *     <root>/experiments/<experimentId>/experiment.json
 *     <root>/experiments/<experimentId>/runs/<runId>.json
 *     <root>/experiments/<experimentId>/reviews/<reviewId>.json
 *
 * `<root>/index.sqlite` is a derived index for listing and lookup by run key; deleting it loses
 * nothing, it is rebuilt from the JSON files on the next `open()`. Call `open()` before use and
 * `close()` after.
 */
export class SqliteRunStore implements RunStore {
  readonly root: string;
  #db: DatabaseSync | undefined;
  readonly #statements = new Map<string, StatementSync>();

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Opens the index, rebuilding it when it is missing, unreadable or at another schema version.
   * Returns the store for chaining: `await new SqliteRunStore(root).open()`.
   */
  async open(): Promise<this> {
    if (this.#db) return this;
    await mkdir(this.root, { recursive: true });
    const indexPath = join(this.root, INDEX_FILE);
    let db: DatabaseSync | undefined;
    let current: boolean;
    try {
      db = connect(indexPath);
      current = schemaVersion(db) === SCHEMA_VERSION;
    } catch {
      // The index is derived data: one SQLite cannot read is deleted and rebuilt.
      db?.close();
      await Promise.all(
        ['', '-wal', '-shm'].map((suffix) => rm(indexPath + suffix, { force: true })),
      );
      db = connect(indexPath);
      current = false;
    }
    this.#db = db;
    if (!current) await this.reindex();
    return this;
  }

  close(): void {
    this.#statements.clear();
    this.#db?.close();
    this.#db = undefined;
  }

  /** Drops the index and rebuilds it from the JSON files under the root. */
  async reindex(): Promise<void> {
    const contents = await this.#scan();
    const db = this.#open();
    this.#statements.clear();
    transaction(db, () => {
      db.exec(DROP_TABLES);
      db.exec(CREATE_TABLES);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        SCHEMA_VERSION,
      );
      const upsertExperiment = db.prepare(UPSERT_EXPERIMENT);
      for (const { value, path } of contents.experiments)
        upsertExperiment.run(...experimentRow(value, path));
      const upsertRun = db.prepare(UPSERT_RUN);
      for (const { value, path } of contents.runs) upsertRun.run(...runRow(value, path));
      const upsertReview = db.prepare(UPSERT_REVIEW);
      for (const { value, path, experimentId } of contents.reviews)
        upsertReview.run(value.id, value.runId, experimentId, path);
    });
  }

  async save(run: Run): Promise<void> {
    const value = parseInput(Run, run, 'run');
    const path = join(EXPERIMENTS_DIR, safe(value.experimentId), 'runs', `${safe(value.id)}.json`);
    await this.#write(path, value);
    const previous = this.#upsert('runs', value.id, UPSERT_RUN, runRow(value, path));
    if (previous !== undefined && previous !== path) await rm(this.#abs(previous), { force: true });
  }

  async get(id: RunId): Promise<Run | undefined> {
    const row = this.#statement('SELECT path FROM runs WHERE id = ?').get(id);
    return row && (await this.#read(Run, text(row, 'path'), id));
  }

  async list(filter: RunFilter = {}): Promise<Run[]> {
    const { experimentId, key } = filter;
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (experimentId !== undefined) {
      conditions.push('experiment_id = ?');
      params.push(experimentId);
    }
    if (key !== undefined) {
      conditions.push(
        'task_hash = ? AND variant_hash = ? AND commit_hash = ? AND subject_model = ? AND claude_code_version = ?',
      );
      params.push(
        key.taskHash,
        key.variantHash,
        key.commitHash,
        key.subjectModel,
        key.claudeCodeVersion,
      );
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.#statement(`SELECT id, path FROM runs${where} ORDER BY started_at, id`).all(
      ...params,
    );
    return Promise.all(rows.map((row) => this.#read(Run, text(row, 'path'), text(row, 'id'))));
  }

  async saveExperiment(experiment: Experiment): Promise<void> {
    const value = parseInput(Experiment, experiment, 'experiment');
    const path = join(EXPERIMENTS_DIR, safe(value.id), 'experiment.json');
    await this.#write(path, value);
    this.#upsert('experiments', value.id, UPSERT_EXPERIMENT, experimentRow(value, path));
  }

  async getExperiment(id: ExperimentId): Promise<Experiment | undefined> {
    const row = this.#statement('SELECT path FROM experiments WHERE id = ?').get(id);
    return row && (await this.#read(Experiment, text(row, 'path'), id));
  }

  async listExperiments(): Promise<Experiment[]> {
    const rows = this.#statement(
      'SELECT id, path FROM experiments ORDER BY created_at DESC, id',
    ).all();
    return Promise.all(
      rows.map((row) => this.#read(Experiment, text(row, 'path'), text(row, 'id'))),
    );
  }

  /** Stores the review next to its run's experiment; the run must already be in the store. */
  async saveReview(review: Review): Promise<void> {
    const value = parseInput(Review, review, 'review');
    const run = this.#statement('SELECT experiment_id FROM runs WHERE id = ?').get(value.runId);
    if (!run) throw new Error(`cannot save review "${value.id}": unknown run "${value.runId}"`);
    const experimentId = text(run, 'experiment_id');
    const path = join(EXPERIMENTS_DIR, experimentId, 'reviews', `${safe(value.id)}.json`);
    await this.#write(path, value);
    const previous = this.#upsert('reviews', value.id, UPSERT_REVIEW, [
      value.id,
      value.runId,
      experimentId,
      path,
    ]);
    if (previous !== undefined && previous !== path) await rm(this.#abs(previous), { force: true });
  }

  async listReviews(filter: { readonly runId?: RunId } = {}): Promise<Review[]> {
    const rows =
      filter.runId === undefined
        ? this.#statement('SELECT id, path FROM reviews').all()
        : this.#statement('SELECT id, path FROM reviews WHERE run_id = ?').all(filter.runId);
    const reviews = await Promise.all(
      rows.map((row) => this.#read(Review, text(row, 'path'), text(row, 'id'))),
    );
    return reviews.sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  #open(): DatabaseSync {
    if (!this.#db) throw new Error(`run store at ${this.root} is not open; call open() first`);
    return this.#db;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#open().prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Upserts one index row in its own transaction; returns the path it had before, if any. */
  #upsert(
    table: 'runs' | 'experiments' | 'reviews',
    id: string,
    sql: string,
    row: SQLInputValue[],
  ): string | undefined {
    let previous: string | undefined;
    transaction(this.#open(), () => {
      const existing = this.#statement(`SELECT path FROM ${table} WHERE id = ?`).get(id);
      previous = existing && text(existing, 'path');
      this.#statement(sql).run(...row);
    });
    return previous;
  }

  #abs(path: string): string {
    return join(this.root, path);
  }

  /** Writes pretty JSON atomically: a sibling temporary file, then a rename over the target. */
  async #write(path: string, value: unknown): Promise<void> {
    const target = this.#abs(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async #read<T extends { readonly id: string }>(
    schema: Schema<T>,
    path: string,
    expectedId: string,
  ): Promise<T> {
    const value = await readFileAs(schema, this.#abs(path));
    if (value.id !== expectedId)
      throw new RunStoreFileError(
        this.#abs(path),
        `holds id "${value.id}" but the index expects "${expectedId}"; run reindex`,
      );
    return value;
  }

  /** Reads and parses every JSON file under the root. */
  async #scan(): Promise<Contents> {
    const contents: Contents = { experiments: [], runs: [], reviews: [] };
    const seenRuns = new Map<string, string>();
    for (const experimentId of await directories(this.#abs(EXPERIMENTS_DIR))) {
      const folder = join(EXPERIMENTS_DIR, experimentId);
      const experimentPath = join(folder, 'experiment.json');
      const experiment = await readFileAs(Experiment, this.#abs(experimentPath), true);
      if (experiment) contents.experiments.push({ value: experiment, path: experimentPath });
      for (const path of await jsonFiles(this.#abs(folder), 'runs')) {
        const relative = join(folder, 'runs', path);
        const run = await readFileAs(Run, this.#abs(relative));
        const other = seenRuns.get(run.id);
        if (other !== undefined)
          throw new RunStoreFileError(
            this.#abs(relative),
            `run "${run.id}" is also stored in ${this.#abs(other)}; keep one`,
          );
        seenRuns.set(run.id, relative);
        contents.runs.push({ value: run, path: relative });
      }
      for (const path of await jsonFiles(this.#abs(folder), 'reviews')) {
        const relative = join(folder, 'reviews', path);
        const review = await readFileAs(Review, this.#abs(relative));
        contents.reviews.push({ value: review, path: relative, experimentId });
      }
    }
    return contents;
  }
}

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function schemaVersion(db: DatabaseSync): string | undefined {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!table) return undefined;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row && text(row, 'value');
}

function transaction(db: DatabaseSync, body: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    body();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`run store index: ${column} is not text`);
  return value;
}

/** Instants as fixed-width UTC text, so the index orders them correctly as strings. */
function instant(iso: string): string {
  return new Date(iso).toISOString();
}

function runRow(run: Run, path: string): SQLInputValue[] {
  return [
    run.id,
    run.experimentId,
    run.taskId,
    armName(run.arm),
    instant(run.startedAt),
    run.key.taskHash,
    run.key.variantHash,
    run.key.commitHash,
    run.key.subjectModel,
    run.key.claudeCodeVersion,
    path,
  ];
}

function experimentRow(experiment: Experiment, path: string): SQLInputValue[] {
  return [experiment.id, instant(experiment.createdAt), path];
}

function safe(id: string): string {
  if (!SAFE_ID.test(id))
    throw new Error(
      `id "${id}" cannot be stored: use letters, digits, ".", "-" or "_", starting with a letter or digit`,
    );
  return id;
}

function describeIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function parseInput<T>(schema: Schema<T>, input: unknown, what: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`invalid ${what}: ${describeIssues(parsed.error.issues)}`);
  return parsed.data;
}

async function readFileAs<T>(schema: Schema<T>, path: string): Promise<T>;
async function readFileAs<T>(
  schema: Schema<T>,
  path: string,
  optional: true,
): Promise<T | undefined>;
async function readFileAs<T>(
  schema: Schema<T>,
  path: string,
  optional = false,
): Promise<T | undefined> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (optional && isMissing(error)) return undefined;
    throw new RunStoreFileError(path, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new RunStoreFileError(path, describeIssues(parsed.error.issues));
  return parsed.data;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Names of the `.json` files in `<folder>/<sub>`, skipping temporary and hidden files. */
async function jsonFiles(folder: string, sub: string): Promise<string[]> {
  try {
    const entries = await readdir(join(folder, sub), { withFileTypes: true });
    return entries
      .filter(
        (entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
