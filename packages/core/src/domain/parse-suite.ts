import { LineCounter, parseDocument } from 'yaml';
import type { z } from 'zod';
import { err, ok, type Result } from '../kernel/result.js';
import { Suite } from './suite.js';

/** One problem found in `suite.yaml`, located by YAML path and, when known, line. */
export interface SuiteIssue {
  /** Dotted path with snake_case keys as written in the file, e.g. `tasks[0].graders[1].type`. */
  readonly path: string;
  /** 1-based line in the file, when the offending node exists. */
  readonly line?: number;
  readonly message: string;
}

/** YAML keys that differ from the camelCase field names, by parent path. */
const SNAKE_TO_CAMEL: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '': { judge_model: 'judgeModel', background_work: 'backgroundWork' },
  limits: {
    max_turns: 'maxTurns',
    max_budget_usd: 'maxBudgetUsd',
    max_duration_ms: 'maxDurationMs',
  },
  margins: { pass_rate: 'passRate' },
};

/**
 * Parses the text of `suite.yaml` (snake_case keys, brief Appendix A) into a `Suite`
 * (camelCase, defaults applied). Never throws; every problem comes back as a `SuiteIssue`
 * with the YAML path and line so the user can fix the file directly.
 */
export function parseSuite(text: string): Result<Suite, SuiteIssue[]> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    return err(
      doc.errors.map((error) => {
        const line = error.linePos?.[0].line;
        return {
          path: '',
          ...(line === undefined ? {} : { line }),
          message: error.message.split('\n')[0] ?? error.message,
        };
      }),
    );
  }

  const raw: unknown = doc.toJS();
  if (!isRecord(raw)) {
    return err([{ path: '', message: 'suite.yaml must be a mapping of keys to values' }]);
  }

  const renameIssues: SuiteIssue[] = [];
  const camel = renameKeys(raw, renameIssues);
  const lineOf = (path: readonly PropertyKey[]): number | undefined => {
    for (let depth = path.length; depth >= 0; depth--) {
      const node: unknown = doc.getIn(path.slice(0, depth), true);
      const start = hasRange(node) ? node.range[0] : undefined;
      if (start !== undefined) return lineCounter.linePos(start).line;
    }
    return undefined;
  };
  for (const issue of renameIssues) {
    const line = lineOf(issue.path.split('.'));
    if (line !== undefined) Object.assign(issue, { line });
  }

  const parsed = Suite.safeParse(camel, { error: requiredMessage });
  if (parsed.success && renameIssues.length === 0) return ok(parsed.data);

  const zodIssues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => toSuiteIssue(issue, lineOf));
  return err([...renameIssues, ...zodIssues]);
}

/** Renders issues one per line, `suite.yaml:12 tasks[0].prompt: must not be empty`. */
export function formatSuiteIssues(issues: readonly SuiteIssue[], file = 'suite.yaml'): string {
  return issues
    .map((issue) => {
      const where = issue.line === undefined ? file : `${file}:${String(issue.line)}`;
      return issue.path === ''
        ? `${where} ${issue.message}`
        : `${where} ${issue.path}: ${issue.message}`;
    })
    .join('\n');
}

function requiredMessage(issue: z.core.$ZodRawIssue): string | undefined {
  return issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : undefined;
}

function renameKeys(raw: Record<string, unknown>, issues: SuiteIssue[]): Record<string, unknown> {
  const rename = (object: Record<string, unknown>, parent: string): Record<string, unknown> => {
    const table = SNAKE_TO_CAMEL[parent] ?? {};
    const camelKeys = new Map(Object.entries(table).map(([snake, camelKey]) => [camelKey, snake]));
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
      const snake = camelKeys.get(key);
      if (snake !== undefined) {
        const path = parent === '' ? key : `${parent}.${key}`;
        issues.push({ path, message: `unknown key; suite.yaml uses snake_case, write "${snake}"` });
        continue;
      }
      out[table[key] ?? key] = value;
    }
    return out;
  };
  const top = rename(raw, '');
  for (const nested of ['limits', 'margins'] as const) {
    const value = top[nested];
    if (isRecord(value)) top[nested] = rename(value, nested);
  }
  return top;
}

function toSuiteIssue(
  issue: z.core.$ZodIssue,
  lineOf: (path: readonly PropertyKey[]) => number | undefined,
): SuiteIssue {
  const yamlPath = issue.path.map((segment, index) => {
    if (typeof segment !== 'string') return segment;
    const parent = index === 0 ? '' : String(issue.path[0]);
    if (index > 1) return segment;
    const table = SNAKE_TO_CAMEL[parent] ?? {};
    const snake = Object.entries(table).find(([, camelKey]) => camelKey === segment)?.[0];
    return snake ?? segment;
  });
  const line = lineOf(yamlPath);
  // Record key failures wrap the key schema's own issue; surface that message instead.
  const message =
    issue.code === 'invalid_key' ? (issue.issues[0]?.message ?? issue.message) : issue.message;
  return { path: formatPath(yamlPath), ...(line === undefined ? {} : { line }), message };
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${String(segment)}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasRange(node: unknown): node is { range: [number, number, number] } {
  return typeof node === 'object' && node !== null && 'range' in node && Array.isArray(node.range);
}
