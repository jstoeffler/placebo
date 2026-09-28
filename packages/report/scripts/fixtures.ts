// Generates packages/report/fixtures/*.json: realistic `Results` for tests, `pnpm dev` and the
// design preview. Seeded, so the output is identical on every run. Run with
// `pnpm --filter @placebo-eval/report fixtures`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Results, RESULTS_SCHEMA_VERSION, type Metric } from '@placebo-eval/core/results';

const SEED = 20260927;
const out = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

// --- Seeded randomness (mulberry32) -------------------------------------------------------------

function seeded(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
    normal: (mean: number, sd: number) => {
      const u = Math.max(next(), 1e-9);
      const v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    hex: (length: number) =>
      Array.from({ length }, () => Math.floor(next() * 16).toString(16)).join(''),
  };
}

type Rng = ReturnType<typeof seeded>;

// --- Shapes (plain JSON; validated by the Results schema at the end) ---------------------------

type Json = Record<string, unknown>;
type ArmName = string;

interface TaskDef {
  readonly id: string;
  readonly prompt: string;
  readonly file: string;
  readonly test: string;
  readonly checklist: readonly string[];
  /** Pass probability per arm. */
  readonly pass: Readonly<Record<ArmName, number>>;
  readonly baseCost: number;
}

const TASKS: readonly TaskDef[] = [
  {
    id: 'fix-refund-rounding',
    prompt:
      'Partial refunds on invoices with tax are off by one cent. Fix the rounding in the refund calculation so the refunded amount never exceeds the captured amount. Must keep working: computeRefund(invoice, amount).',
    file: 'src/billing/refund.ts',
    test: 'tests/hidden/refund.spec.ts',
    checklist: [
      'Does the fix round in integer cents rather than floating-point dollars?',
      'Is the refunded amount capped at the captured amount?',
      'Did it avoid changing unrelated billing code?',
    ],
    pass: { control: 0.6, none: 0.4, 'tests-first': 0.8 },
    baseCost: 0.42,
  },
  {
    id: 'add-invoice-csv-export',
    prompt:
      'Add a CSV export for invoices: GET /invoices/export.csv returns one row per invoice with id, customer, total and status, filtered by the same query parameters as GET /invoices.',
    file: 'src/routes/invoices.ts',
    test: 'tests/hidden/invoices-export.spec.ts',
    checklist: [
      'Does the export reuse the existing invoice query filters?',
      'Are commas and quotes in customer names escaped?',
      'Is there a test for the new route?',
    ],
    pass: { control: 0.8, none: 0.6, 'tests-first': 1 },
    baseCost: 0.61,
  },
  {
    id: 'validate-webhook-signature',
    prompt:
      'Incoming payment webhooks are processed without checking the signature. Verify the Stripe-Signature header with the webhook secret and reject invalid or stale events with 400.',
    file: 'src/webhooks/stripe.ts',
    test: 'tests/hidden/webhook-signature.spec.ts',
    checklist: [
      'Is the comparison constant-time?',
      'Are events older than five minutes rejected?',
      'Did it avoid logging the secret?',
    ],
    pass: { control: 0.6, none: 0.6, 'tests-first': 0.6 },
    baseCost: 0.38,
  },
  {
    id: 'migrate-date-utils',
    prompt:
      'Replace moment with date-fns across src/reporting. Keep the output of formatPeriod(start, end) byte-identical.',
    file: 'src/reporting/period.ts',
    test: 'tests/hidden/period.spec.ts',
    checklist: [
      'Is moment removed from package.json?',
      'Does formatPeriod keep its exact output format?',
    ],
    pass: { control: 0, none: 0, 'tests-first': 0 },
    baseCost: 0.95,
  },
  {
    id: 'rename-customer-field',
    prompt:
      'Rename the customer field `vatNumber` to `taxId` in the API and the database model, with a migration. Old API clients sending vatNumber must keep working for one release.',
    file: 'src/customers/model.ts',
    test: 'tests/hidden/customer-tax-id.spec.ts',
    checklist: [
      'Is there a reversible migration?',
      'Does the API still accept vatNumber?',
      'Are all call sites updated?',
    ],
    pass: { control: 0.8, none: 0.6, 'tests-first': 0.8 },
    baseCost: 0.5,
  },
];

/** Relative effect of each arm on the cost-like metrics (1 = same as control). */
const ARM_EFFECT: Readonly<Record<ArmName, { cost: number; tokensOut: number; turns: number }>> = {
  control: { cost: 1, tokensOut: 1, turns: 0 },
  none: { cost: 0.8, tokensOut: 0.97, turns: -1.2 },
  'tests-first': { cost: 1.12, tokensOut: 1.3, turns: 1.4 },
};

const SUBJECT = 'claude-sonnet-5-20260801';
const JUDGE = 'claude-opus-5-5-20260915';
const CLAUDE_CODE = '2.1.283';

function sha(rng: Rng) {
  return rng.hex(64);
}

/**
 * What one judge call per repeat cost, derived from the text the judge read and wrote so the
 * fixture stays deterministic without drawing from the seeded source.
 */
function judgeSpend(read: string, wrote: string, calls = 1): Json {
  const input = calls * (1800 + read.length * 4);
  const output = calls * (60 + Math.round(wrote.length / 3));
  const costUsd = Math.round(((input * 5 + output * 25) / 1_000_000) * 10000) / 10000;
  return { costUsd, tokens: { input, output, cacheRead: 0, cacheWrite: 0 }, calls };
}

function iso(ms: number) {
  return new Date(ms).toISOString();
}

// --- One run ---------------------------------------------------------------------------------

interface Built {
  readonly run: Json;
  readonly metrics: Partial<Record<Metric, number>>;
}

function armJson(arm: ArmName): Json {
  if (arm === 'control') return { kind: 'control' };
  return { kind: 'treatment', variant: arm, patch: `variants/${arm}.patch` };
}

function changeFor(task: TaskDef, passed: boolean, rng: Rng): { diff: string; files: string[] } {
  const lines = [
    `diff --git a/${task.file} b/${task.file}`,
    `index ${rng.hex(7)}..${rng.hex(7)} 100644`,
    `--- a/${task.file}`,
    `+++ b/${task.file}`,
    '@@ -12,9 +12,13 @@ export function compute(input: Input): Output {',
    '   const captured = toCents(input.captured);',
    '-  const requested = input.amount * 100;',
    '-  const refund = Math.round(requested * (1 + input.taxRate)) / 100;',
    '+  const requested = toCents(input.amount);',
    '+  const withTax = Math.floor(requested * (1 + input.taxRate));',
    passed ? '+  const refund = Math.min(withTax, captured);' : '+  const refund = withTax;',
    '+',
    '+  // Amounts stay in integer cents until they leave this module.',
    '   if (refund <= 0) {',
    "     throw new RefundError('nothing to refund');",
    '   }',
    '-  return { amount: refund, currency: input.currency };',
    '+  return { amount: fromCents(refund), currency: input.currency };',
    ' }',
  ];
  const files = [task.file];
  if (rng.next() < 0.6) {
    const testFile = task.file.replace(/^src\//, 'tests/').replace(/\.ts$/, '.test.ts');
    files.push(testFile);
    lines.push(
      `diff --git a/${testFile} b/${testFile}`,
      'new file mode 100644',
      `index 0000000..${rng.hex(7)}`,
      '--- /dev/null',
      `+++ b/${testFile}`,
      '@@ -0,0 +1,12 @@',
      "+import { describe, expect, it } from 'vitest';",
      `+import { compute } from '../${task.file.replace(/^src\//, 'src/').replace(/\.ts$/, '.js')}';`,
      '+',
      "+describe('compute', () => {",
      "+  it('never exceeds the captured amount', () => {",
      '+    const result = compute({ captured: 10.01, amount: 10.01, taxRate: 0.2 });',
      '+    expect(result.amount).toBeLessThanOrEqual(10.01);',
      '+  });',
      '+',
      "+  it('keeps cents exact', () => {",
      '+    expect(compute({ captured: 5, amount: 1.1, taxRate: 0 }).amount).toBe(1.1);',
      '+  });',
      '+});',
    );
  }
  files.sort();
  return { diff: `${lines.join('\n')}\n`, files };
}

function buildRun(opts: {
  rng: Rng;
  experimentId: string;
  task: TaskDef;
  taskIndex: number;
  arm: ArmName;
  ordinal: number;
  start: number;
  commit: string;
  taskHash: string;
  variantHash: string;
  withChecklist: boolean;
}): Built {
  const { rng, task, arm } = opts;
  const effect = ARM_EFFECT[arm] ?? { cost: 1, tokensOut: 1, turns: 0 };
  const crashed = arm === 'none' && task.id === 'validate-webhook-signature' && opts.ordinal === 3;
  const denied = arm === 'tests-first' && task.id === 'rename-customer-field' && opts.ordinal === 5;
  const passed = !crashed && !denied && rng.next() < (task.pass[arm] ?? 0.5);
  const outcome = crashed
    ? 'crashed'
    : denied
      ? 'stopped_by_permission_denial'
      : passed || rng.next() < 0.7
        ? 'completed'
        : 'failed';

  const turns = Math.max(3, Math.round(rng.normal(11 + effect.turns, 2.2)));
  // The system prompt and project files are cached once per run, so cache writes barely vary.
  const cacheWritePerTurn = Math.max(0, rng.normal(16_000, 250)) / turns;
  const events: Json[] = [];
  let t = opts.start;
  const step = (lo: number, hi: number) => (t += rng.int(lo, hi));
  events.push({
    type: 'system_init',
    timestamp: iso(t),
    model: SUBJECT,
    claudeCodeVersion: CLAUDE_CODE,
    tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'TodoWrite'],
  });

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const byTool: Record<string, number> = {};
  let filesRead = 0;
  let bytesRead = 0;
  let searchCalls = 0;
  let callId = 0;
  const call = (name: string, input: Json, output: string, isError = false) => {
    callId += 1;
    const id = `toolu_${String(opts.taskIndex)}${String(opts.ordinal)}${String(callId).padStart(3, '0')}`;
    events.push({ type: 'tool_call', timestamp: iso(step(300, 1500)), id, name, input });
    events.push({
      type: 'tool_result',
      timestamp: iso(step(80, 2400)),
      id,
      output,
      isError,
    });
    byTool[name] = (byTool[name] ?? 0) + 1;
    if (name === 'Read') {
      filesRead += 1;
      bytesRead += output.length;
    }
    if (name === 'Grep' || name === 'Glob') searchCalls += 1;
  };
  const usage = (scale: number) => {
    const u = {
      input: Math.round(Math.max(200, rng.normal(2400, 600)) * scale),
      output: Math.round(Math.max(40, rng.normal(420, 160)) * effect.tokensOut),
      cacheRead: Math.round(Math.max(0, rng.normal(18000, 3000)) * scale),
      cacheWrite: Math.round(cacheWritePerTurn),
    };
    totals.input += u.input;
    totals.output += u.output;
    totals.cacheRead += u.cacheRead;
    totals.cacheWrite += u.cacheWrite;
    events.push({ type: 'usage', timestamp: iso(step(50, 200)), ...u });
  };
  const say = (text: string) => {
    events.push({ type: 'assistant_text', timestamp: iso(step(1500, 6000)), text });
  };
  const module = task.file.split('/').at(-1)?.replace(/\.ts$/, '') ?? 'module';
  const source = [
    "import { toCents, fromCents } from '../money.js';",
    '',
    'export function compute(input: Input): Output {',
    '  const captured = toCents(input.captured);',
    '  const requested = input.amount * 100;',
    '  // …',
    '}',
  ].join('\n');

  const script: (() => void)[] = [
    () => {
      say(`I'll start by finding where ${module} is implemented and how it is tested.`);
      call(
        'Grep',
        { pattern: module, path: 'src', output_mode: 'files_with_matches' },
        `${task.file}\nsrc/index.ts`,
      );
    },
    () => {
      call('Read', { file_path: task.file }, source);
    },
    () => {
      call(
        'Glob',
        { pattern: 'tests/**/*.test.ts' },
        'tests/billing/invoice.test.ts\ntests/money.test.ts',
      );
      call('Read', { file_path: 'src/money.ts' }, 'export const toCents = (n: number) => …');
    },
    () => {
      say(
        arm === 'tests-first'
          ? 'Following the project rule, I will write a failing test first.'
          : 'The bug is clear: the amount is converted to cents with floating-point multiplication.',
      );
      call(
        'Edit',
        {
          file_path: task.file,
          old_string: '  const requested = input.amount * 100;',
          new_string: '  const requested = toCents(input.amount);',
        },
        `The file ${task.file} has been updated.`,
      );
    },
    () => {
      call(
        'Bash',
        { command: 'pnpm vitest run tests/billing', description: 'Run billing tests' },
        passed
          ? ' ✓ tests/billing/invoice.test.ts (14 tests) 212ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)'
          : ' ✗ tests/billing/invoice.test.ts > refund > caps at captured\n   AssertionError: expected 1202 to be less than or equal to 1201\n\n Test Files  1 failed (1)\n      Tests  1 failed | 13 passed (14)',
        !passed,
      );
    },
    () => {
      call(
        'Bash',
        { command: 'pnpm tsc --noEmit', description: 'Typecheck' },
        rng.next() < 0.2 ? "src/billing/refund.ts(18,9): error TS2322: Type 'string'…" : '',
      );
    },
  ];
  for (let turn = 0; turn < turns; turn += 1) {
    const action = script[turn];
    if (action !== undefined) action();
    else if (rng.next() < 0.5)
      call('Read', { file_path: rng.pick(['src/index.ts', 'src/money.ts', 'package.json']) }, '…');
    else
      call(
        'Grep',
        { pattern: rng.pick(['captured', 'taxRate', 'RefundError']), path: 'src' },
        task.file,
      );
    usage(1 + turn * 0.04);
  }
  if (denied) {
    call(
      'Bash',
      { command: 'psql $DATABASE_URL -f migrations/0042_tax_id.sql' },
      'Permission denied: Bash(psql:*) is not allowed in this run folder.',
      true,
    );
  } else if (!crashed) {
    say(
      passed
        ? `Done. ${module} now works in integer cents and never refunds more than was captured. Tests pass.`
        : `I changed ${module} to work in integer cents. One existing test still fails; it may encode the old behaviour.`,
    );
  }

  const costUsd =
    Math.max(0.05, rng.normal(opts.task.baseCost * effect.cost, opts.task.baseCost * 0.05)) *
    (crashed ? 0.4 : 1);
  const durationMs = Math.round(Math.max(20_000, rng.normal(95_000 * effect.cost, 12_000)));
  const finish = opts.start + durationMs;
  events.push({
    type: 'result',
    timestamp: iso(finish),
    outcome,
    costUsd: Math.round(costUsd * 10000) / 10000,
    turns,
    durationMs,
    apiDurationMs: Math.round(durationMs * 0.78),
    stopReason: crashed ? null : denied ? 'permission_denied' : 'end_turn',
    permissionDenials: denied
      ? [
          {
            tool: 'Bash',
            toolCallId: `toolu_${String(opts.taskIndex)}${String(opts.ordinal)}${String(callId).padStart(3, '0')}`,
            input: { command: 'psql $DATABASE_URL -f migrations/0042_tax_id.sql' },
          },
        ]
      : [],
  });

  const change = crashed ? { diff: '', files: [] as string[] } : changeFor(task, passed, rng);
  const grades: Json[] = [
    {
      grader: { type: 'command', index: 0 },
      kind: 'deterministic',
      score: passed ? 1 : 0,
      passed,
      detail: {
        type: 'command',
        command: `pnpm vitest run ${task.test}`,
        exitCode: crashed ? null : passed ? 0 : 1,
        stdout: passed
          ? `\n RUN  v5.0.2 /runs/${task.id}\n\n ✓ ${task.test} (6 tests) 48ms\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)\n   Duration  1.21s\n`
          : `\n RUN  v5.0.2 /runs/${task.id}\n\n ❯ ${task.test} (6 tests | 2 failed) 51ms\n   × caps the refund at the captured amount\n   × keeps tax in integer cents\n\n Test Files  1 failed (1)\n      Tests  2 failed | 4 passed (6)\n`,
        stderr: passed
          ? ''
          : `FAIL  ${task.test} > caps the refund at the captured amount\nAssertionError: expected 1202 to be 1201 // Object.is equality\n\n- Expected\n+ Received\n\n- 1201\n+ 1202\n\n ❯ ${task.test}:31:28\n`,
        durationMs: rng.int(900, 4200),
      },
    },
    {
      grader: { type: 'file_modified', index: 1 },
      kind: 'deterministic',
      score: crashed ? 0 : 1,
      passed: !crashed,
      detail: {
        type: 'check',
        message: crashed ? `${task.file} was not modified` : `${task.file} was modified`,
      },
    },
  ];

  let checklist: number | undefined;
  if (opts.withChecklist && crashed) {
    grades.push({
      grader: { type: 'checklist', index: 2 },
      kind: 'judge',
      score: 0,
      detail: {
        type: 'error',
        message: 'The judge answer failed its schema: answers has 2 items, the checklist has 3.',
      },
    });
  } else if (opts.withChecklist) {
    const answers = task.checklist.map((question, index) => {
      const yes = rng.next() < (passed ? 0.85 : 0.35) - index * 0.05;
      return {
        question,
        yes,
        note: yes
          ? 'The change shows this directly.'
          : 'Not visible in the change; the relevant code path is untouched.',
      };
    });
    checklist = answers.filter((answer) => answer.yes).length;
    const reasoning = passed
      ? 'The change converts to integer cents at the boundary and caps the refund with Math.min against the captured amount. Unrelated billing code is untouched. The new test covers the cap but not tax rounding.'
      : 'The change moves to integer cents but does not cap the refund at the captured amount, so the over-refund remains for amounts with tax. The edit is otherwise contained to the refund module.';
    grades.push({
      grader: { type: 'checklist', index: 2 },
      kind: 'judge',
      score: checklist,
      detail: {
        type: 'judge',
        model: JUDGE,
        reasoning,
        raw: [{ answers: answers.map((answer) => answer.yes) }],
        answers,
        spend: judgeSpend(change.diff, reasoning),
      },
    });
  }

  const measurements = {
    tokens: totals,
    costUsd: Math.round(costUsd * 10000) / 10000,
    turns,
    durationMs,
    apiDurationMs: Math.round(durationMs * 0.78),
    toolCalls: { total: Object.values(byTool).reduce((a, b) => a + b, 0), byTool },
    filesRead,
    bytesRead,
    searchCalls,
    changeBytes: Buffer.byteLength(change.diff),
    filesTouched: change.files.length,
  };

  const run: Json = {
    id: `run_${task.id.split('-')[0] ?? 'task'}_${arm.replace('-', '')}_${String(opts.ordinal)}_${rng.hex(6)}`,
    experimentId: opts.experimentId,
    key: {
      taskHash: opts.taskHash,
      variantHash: opts.variantHash,
      commitHash: opts.commit,
      subjectModel: SUBJECT,
      claudeCodeVersion: CLAUDE_CODE,
    },
    taskId: task.id,
    arm: armJson(arm),
    startedAt: iso(opts.start),
    finishedAt: iso(finish),
    outcome,
    measurements,
    events,
    change: { ...change, bytes: Buffer.byteLength(change.diff) },
    grades,
    runFolder: `/Users/dev/acme-billing/.placebo/runs/${opts.experimentId}/${task.id}/${arm}/${String(opts.ordinal)}`,
    infraRetries: crashed ? 1 : 0,
  };
  const metrics: Partial<Record<Metric, number>> = {
    passRate: passed ? 1 : 0,
    costUsd: measurements.costUsd,
    tokensIn: totals.input,
    tokensOut: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    turns,
    durationMs,
  };
  if (checklist !== undefined) metrics.checklist = checklist;
  return { run, metrics };
}

// --- Statistics for the card (a small stand-in for core's resampling) --------------------------

const UNIT: Readonly<Record<Metric, 'pts' | 'percent' | 'absolute'>> = {
  passRate: 'pts',
  costUsd: 'percent',
  tokensIn: 'percent',
  tokensOut: 'percent',
  cacheRead: 'percent',
  cacheWrite: 'percent',
  turns: 'absolute',
  durationMs: 'percent',
  checklist: 'absolute',
  winRate: 'pts',
};
const HIGHER_IS_BETTER: Partial<Record<Metric, boolean>> = {
  passRate: true,
  checklist: true,
  winRate: true,
};
const MARGIN: Partial<Record<Metric, number>> = {
  passRate: 5,
  costUsd: 10,
  tokensIn: 10,
  tokensOut: 10,
  cacheRead: 10,
  cacheWrite: 10,
  durationMs: 15,
};

const mean = (values: readonly number[]) =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

function taskDifference(metric: Metric, control: readonly number[], treatment: readonly number[]) {
  const c = mean(control);
  const t = mean(treatment);
  if (UNIT[metric] === 'pts') return (t - c) * 100;
  if (UNIT[metric] === 'percent') return ((t - c) / c) * 100;
  return t - c;
}

function draw<T>(rng: Rng, items: readonly T[]): T[] {
  return items.map(() => rng.pick(items));
}

/** Like core: a task needs two runs per arm it compares, and a nonzero control for `percent`. */
function exclusionOf(
  metric: Metric,
  task: { control: number[]; treatment: number[] },
): 'too_few_runs' | 'control_zero' | undefined {
  const reference = metric === 'winRate';
  if (task.treatment.length < 2 || (!reference && task.control.length < 2)) return 'too_few_runs';
  if (UNIT[metric] === 'percent' && mean(task.control) === 0) return 'control_zero';
  return undefined;
}

function metricRow(
  rng: Rng,
  metric: Metric,
  tasks: readonly { taskId: string; control: number[]; treatment: number[] }[],
  runsPerTask: number,
): Json {
  const excludedTasks = tasks.flatMap((task) => {
    const reason = exclusionOf(metric, task);
    return reason === undefined ? [] : [{ taskId: task.taskId, reason }];
  });
  const excluded = excludedTasks.length === 0 ? {} : { excludedTasks };
  const perTask = tasks.filter((task) => exclusionOf(metric, task) === undefined);
  const margin = MARGIN[metric] ?? null;
  if (perTask.length === 0) {
    const thin = excludedTasks.some((task) => task.reason === 'too_few_runs');
    return {
      metric,
      difference: 0,
      range: [0, 0],
      verdict: 'no_evidence',
      margin,
      ...(thin ? { runsNeeded: 2 } : {}),
      taskCount: 0,
      runCount: 0,
      ...excluded,
    };
  }
  const diffOf = (tasks: readonly { control: number[]; treatment: number[] }[]) =>
    mean(tasks.map((task) => taskDifference(metric, task.control, task.treatment)));
  const difference = diffOf(perTask);
  const samples: number[] = [];
  for (let i = 0; i < 1000; i += 1) {
    const tasks = draw(rng, perTask).map((task) => ({
      control: draw(rng, task.control),
      treatment: draw(rng, task.treatment),
    }));
    samples.push(diffOf(tasks));
  }
  samples.sort((a, b) => a - b);
  const lo = samples[25] ?? difference;
  const hi = samples[974] ?? difference;
  const good = HIGHER_IS_BETTER[metric] === true ? 1 : -1;
  let verdict: string;
  if (margin !== null && lo >= -margin && hi <= margin) verdict = 'placebo';
  else if (lo > 0 || hi < 0) verdict = Math.sign(difference) === good ? 'helps' : 'harms';
  else verdict = 'no_evidence';
  const row: Json = {
    metric,
    difference: round(difference),
    range: [round(lo), round(hi)],
    verdict,
    margin,
    taskCount: perTask.length,
    runCount: perTask.reduce((n, task) => n + task.control.length + task.treatment.length, 0),
    ...excluded,
  };
  if (verdict === 'no_evidence') {
    const half = (hi - lo) / 2;
    const target = Math.max(Math.abs(difference), (margin ?? Math.abs(difference)) / 2, 1e-6);
    const needed = Math.max(runsPerTask + 1, Math.ceil(runsPerTask * (half / target) ** 2));
    // Like core, an estimate above 1000 runs per task is left out ("more than 1000").
    if (needed <= 1000) row.runsNeeded = needed;
  }
  return row;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// --- Rich fixture ------------------------------------------------------------------------------

function rich() {
  const rng = seeded(SEED);
  const experimentId = 'exp_2026-09-27_7f3a';
  const commit = rng.hex(40);
  const arms: ArmName[] = ['control', 'none', 'tests-first'];
  const runsPerTask = 5;
  const taskHash = Object.fromEntries(TASKS.map((task) => [task.id, sha(rng)]));
  const variantHash = Object.fromEntries(arms.map((arm) => [arm, sha(rng)]));
  const start = Date.parse('2026-09-27T09:12:00Z');

  const built: (Built & { task: string; arm: ArmName })[] = [];
  let clock = start;
  for (const [taskIndex, task] of TASKS.entries()) {
    for (const arm of arms) {
      for (let ordinal = 1; ordinal <= runsPerTask; ordinal += 1) {
        clock += rng.int(20_000, 90_000);
        built.push({
          ...buildRun({
            rng,
            experimentId,
            task,
            taskIndex,
            arm,
            ordinal,
            start: clock,
            commit,
            taskHash: taskHash[task.id] ?? '',
            variantHash: variantHash[arm] ?? '',
            withChecklist: true,
          }),
          task: task.id,
          arm,
        });
      }
    }
  }

  // Comparison judge: every treatment run against a random control run of the same task.
  for (const entry of built) {
    if (entry.arm === 'control') continue;
    const opponents = built.filter((other) => other.task === entry.task && other.arm === 'control');
    const opponent = rng.pick(opponents);
    const edge = (entry.metrics.passRate ?? 0) - (opponent.metrics.passRate ?? 0);
    const won = edge > 0 || (edge === 0 && rng.next() < (entry.arm === 'tests-first' ? 0.6 : 0.45));
    const position = rng.next() < 0.5 ? 'a' : 'b';
    const other = position === 'a' ? 'b' : 'a';
    const reason = won
      ? `Result ${position} keeps the arithmetic in integer cents end to end and adds a focused test; result ${other} converts back to dollars mid-calculation, which reintroduces the rounding it set out to fix.`
      : `Result ${other} is the smaller, more direct change and caps the refund explicitly; result ${position} also rewrites the tax helper without need, which widens the change for no gain.`;
    const shown = (entry.run.change as { diff: string }).diff;
    const opposed = (opponent.run.change as { diff: string }).diff;
    entry.metrics.winRate = won ? 1 : 0;
    (entry.run.grades as Json[]).push({
      grader: { type: 'comparison', index: 3 },
      kind: 'judge',
      score: won ? 1 : 0,
      detail: {
        type: 'comparison',
        opponentRunId: opponent.run.id,
        position,
        preferred: won,
        reason,
        model: JUDGE,
        raw: [{ better: won ? position : other, reason }],
        spend: judgeSpend(shown + opposed, reason),
      },
    });
  }

  // Reviews: two people reviewed a handful of runs.
  const reviews: Json[] = [];
  const reviewed = built.filter((entry) => entry.task === 'fix-refund-rounding').slice(0, 11);
  for (const [i, entry] of reviewed.entries()) {
    if (i % 3 !== 0 && i !== 10) continue;
    const reviewer = i % 2 === 0 ? 'Maya Okafor' : 'Tomás Reyes';
    const task = TASKS[0];
    if (task === undefined) continue;
    const answers = task.checklist.map((question, index) => ({
      question,
      yes: (entry.metrics.passRate ?? 0) === 1 ? index !== 2 || i % 2 === 0 : index === 0,
      ...(index === 1 ? { note: 'Checked by running the app against invoice INV-1042.' } : {}),
    }));
    const id = `rev_${rng.hex(8)}`;
    const createdAt = iso(start + 6 * 3600_000 + i * 240_000);
    reviews.push({
      id,
      runId: entry.run.id,
      reviewer,
      createdAt,
      answer: { type: 'checklist', answers },
    });
    (entry.run.grades as Json[]).push({
      grader: { type: 'review', index: null },
      kind: 'review',
      score: answers.filter((answer) => answer.yes).length,
      detail: { type: 'review', reviewId: id, reviewer, answers },
    });
  }

  const dead = TASKS.filter((task) =>
    built.filter((entry) => entry.task === task.id).every((entry) => entry.metrics.passRate === 0),
  ).map((task) => task.id);

  const metrics: Metric[] = [
    'passRate',
    'costUsd',
    'tokensIn',
    'tokensOut',
    'cacheRead',
    'cacheWrite',
    'turns',
    'durationMs',
    'checklist',
    'winRate',
  ];
  const cards = arms
    .filter((arm) => arm !== 'control')
    .map((arm) => ({
      variant: arm,
      rows: metrics.flatMap((metric) => {
        const perTask = TASKS.filter((task) => !dead.includes(task.id)).map((task) => {
          const pick = (which: ArmName) =>
            built
              .filter((entry) => entry.task === task.id && entry.arm === which)
              .map((entry) => entry.metrics[metric])
              .filter((value): value is number => value !== undefined);
          if (metric === 'winRate') {
            // Win rate is the treatment's share of wins against control; its difference is
            // measured from an even split.
            const own = pick(arm);
            return { taskId: task.id, control: own.map(() => 0.5), treatment: own };
          }
          return { taskId: task.id, control: pick('control'), treatment: pick(arm) };
        });
        if (perTask.some((task) => task.control.length === 0 || task.treatment.length === 0))
          return [];
        return [metricRow(rng, metric, perTask, runsPerTask)];
      }),
    }));

  const breakdown = TASKS.flatMap((task) =>
    arms.map((arm) => {
      const entries = built.filter((entry) => entry.task === task.id && entry.arm === arm);
      const means: Partial<Record<Metric, number | null>> = {};
      for (const metric of metrics) {
        const values = entries
          .map((entry) => entry.metrics[metric])
          .filter((value): value is number => value !== undefined);
        if (metric === 'winRate' && arm === 'control') continue;
        means[metric] = values.length === 0 ? null : round(mean(values));
      }
      return { taskId: task.id, arm, runCount: entries.length, means };
    }),
  );

  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: iso(clock + 3 * 3600_000),
    experiment: {
      id: experimentId,
      createdAt: iso(start),
      pins: {
        commit,
        subjectModel: SUBJECT,
        judgeModel: JUDGE,
        claudeCodeVersion: CLAUDE_CODE,
        suiteHash: sha(rng),
        placeboVersion: '0.1.0',
      },
      runsPerTask,
      taskIds: TASKS.map((task) => task.id),
      arms: arms.map(armJson),
      seed: SEED,
    },
    arms: arms.map(armJson),
    margins: { passRate: 5, cost: 10, tokens: 10, duration: 15 },
    tasks: TASKS.map((task) => ({
      id: task.id,
      prompt: task.prompt,
      graders: [
        { index: 0, type: 'command', label: `command: pnpm vitest run ${task.test}` },
        { index: 1, type: 'file_modified', label: `file modified: ${task.file}` },
        { index: 2, type: 'checklist', label: `checklist: tasks/${task.id}/checklist.md` },
        { index: 3, type: 'comparison', label: 'comparison against control' },
      ],
    })),
    runs: built.map((entry) => entry.run),
    verdictCards: cards,
    breakdown,
    deadTasks: dead,
    warnings: [
      ...dead.map((taskId) => ({ type: 'dead_task', taskId })),
      {
        type: 'patch_outside_surface',
        variant: 'tests-first',
        paths: ['docs/architecture.md', 'vitest.config.ts'],
      },
      { type: 'isolation_residual', sources: ['global_config', 'managed_settings'] },
      { type: 'ancestor_configuration', paths: ['/Users/ada/CLAUDE.md'] },
    ],
    reviews,
  };
}

// --- Minimal fixture ---------------------------------------------------------------------------

function minimal() {
  const rng = seeded(SEED + 1);
  const experimentId = 'exp_2026-09-26_01';
  const commit = rng.hex(40);
  const task = TASKS[2];
  if (task === undefined) throw new Error('no task');
  const start = Date.parse('2026-09-26T16:40:00Z');
  const runs = (['control', 'none'] as const).map((arm, i) =>
    buildRun({
      rng,
      experimentId,
      task,
      taskIndex: 0,
      arm,
      ordinal: 1,
      start: start + i * 120_000,
      commit,
      taskHash: sha(rng),
      variantHash: sha(rng),
      withChecklist: false,
    }),
  );
  return {
    schemaVersion: RESULTS_SCHEMA_VERSION,
    generatedAt: iso(start + 600_000),
    experiment: {
      id: experimentId,
      createdAt: iso(start),
      pins: {
        commit,
        subjectModel: SUBJECT,
        judgeModel: JUDGE,
        claudeCodeVersion: CLAUDE_CODE,
        suiteHash: sha(rng),
        placeboVersion: '0.1.0',
      },
      runsPerTask: 1,
      taskIds: [task.id],
      arms: [armJson('control'), armJson('none')],
      seed: SEED + 1,
    },
    arms: [armJson('control'), armJson('none')],
    margins: { passRate: 5, cost: 10, tokens: 10, duration: 15 },
    tasks: [
      {
        id: task.id,
        prompt: task.prompt,
        graders: [
          { index: 0, type: 'command', label: `command: pnpm vitest run ${task.test}` },
          { index: 1, type: 'file_modified', label: `file modified: ${task.file}` },
        ],
      },
    ],
    runs: runs.map((entry) => entry.run),
    verdictCards: [
      {
        variant: 'none',
        // One run per arm: no task has the two runs a range needs, so no row decides.
        rows: (['passRate', 'costUsd'] as const).map((metric) =>
          metricRow(
            rng,
            metric,
            [
              {
                taskId: task.id,
                control: [runs[0]?.metrics[metric] ?? 0],
                treatment: [runs[1]?.metrics[metric] ?? 0],
              },
            ],
            1,
          ),
        ),
      },
    ],
    breakdown: runs.map((entry, i) => ({
      taskId: task.id,
      arm: i === 0 ? 'control' : 'none',
      runCount: 1,
      means: { passRate: entry.metrics.passRate ?? null, costUsd: entry.metrics.costUsd ?? null },
    })),
    deadTasks: [],
    warnings: [
      { type: 'few_tasks', taskCount: 1, threshold: 5 },
      { type: 'few_runs', runsPerTask: 1, threshold: 3 },
    ],
    reviews: [],
  };
}

for (const [name, data] of [
  ['rich.json', rich()],
  ['minimal.json', minimal()],
] as const) {
  const parsed = Results.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${name} does not match Results: ${JSON.stringify(parsed.error.issues[0])}`);
  }
  writeFileSync(out(name), `${JSON.stringify(data, null, 2)}\n`);
}
