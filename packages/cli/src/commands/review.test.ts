import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReviewSession } from '@placebo-eval/core/results';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteRunStore } from '../adapters/sqlite-store/sqlite-run-store.js';
import type { Host } from '../host.js';
import { RESULTS_PLACEHOLDER } from '../report-files.js';
import { commitFiles, placebo, put, type Ran, tempRepo } from './test-support.js';

let temp: string;
let repo: string;
let home: string;
let template: string;

const PATCH = [
  'diff --git a/CLAUDE.md b/CLAUDE.md',
  'deleted file mode 100644',
  '--- a/CLAUDE.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-Keep it short.',
  '',
].join('\n');

beforeEach(async () => {
  ({ temp, repo, home } = await tempRepo());
  const commit = await commitFiles(repo, { 'CLAUDE.md': 'Keep it short.\n', 'README.md': '# x\n' });
  await put(join(repo, '.placebo'), {
    'suite.yaml': [
      `commit: "${commit}"`,
      'model: claude-sonnet-5',
      'judge_model: claude-opus-5-5',
      'runs: 1',
      'variants:',
      '  none: { patch: variants/none.patch }',
      'tasks:',
      '  - id: add-notes',
      '    prompt: Add a file named NOTES.md.',
      '    graders:',
      '      - { type: file_exists, path: NOTES.md }',
      '      - { type: checklist, questions: tasks/add-notes/checklist.md }',
      '      - { type: comparison }',
      '',
    ].join('\n'),
    'variants/none.patch': PATCH,
    'tasks/add-notes/checklist.md': '- Is NOTES.md there?\n',
  });
  template = join(temp, 'template.html');
  await writeFile(
    template,
    `<script id="placebo-results" type="application/json">${RESULTS_PLACEHOLDER}</script>`,
  );
}, 30_000);

afterEach(async () => {
  await rm(temp, { recursive: true, force: true });
});

const where = () => ({ repo, home });

async function runOnce(): Promise<string> {
  const ran = await placebo(['run', '--runner', 'fake', '--seed', '3', '--quiet'], where(), {
    reportTemplate: template,
  });
  expect(ran.exitCode).toBe(0);
  const id = /reports\/([^/]+)\/report\.html/.exec(ran.stdout)?.[1];
  if (id === undefined) throw new Error(`no experiment id in ${ran.stdout}`);
  return id;
}

/** Starts `placebo review`, with a fake opener and a Ctrl-C the test presses. */
function startReview(args: readonly string[]): {
  readonly done: Promise<Ran>;
  readonly opened: string[];
  readonly interrupt: () => Promise<void>;
} {
  const opened: string[] = [];
  let handler: (() => void) | undefined;
  const host: Partial<Host> = {
    reportTemplate: template,
    openUrl: (url) => opened.push(url),
    onInterrupt: (on) => {
      handler = on;
      return () => (handler = undefined);
    },
  };
  const done = placebo(['review', ...args], where(), host);
  return {
    done,
    opened,
    interrupt: async () => {
      await vi.waitFor(() => {
        expect(handler).toBeDefined();
      });
      handler?.();
    },
  };
}

describe('placebo review', () => {
  it('serves the newest experiment, opens it, saves reviews and says how to report them', async () => {
    const id = await runOnce();
    const review = startReview(['--reviewer', 'julien']);
    await vi.waitFor(() => {
      expect(review.opened).toHaveLength(1);
    });
    const url = review.opened[0] ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const session = ReviewSession.parse(
      await (await fetch(new URL('/api/session?reviewer=julien', url))).json(),
    );
    const [item] = session.items;
    if (item === undefined) throw new Error('no item');
    const answered = await fetch(new URL('/api/answers', url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: item.token,
        reviewer: 'julien',
        answer: {
          type: 'checklist',
          answers: [{ question: 'Is NOTES.md there?', yes: true }],
        },
      }),
    });
    expect(answered.status).toBe(200);
    await review.interrupt();
    const ran = await review.done;
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toBe(
      [
        `reviewing 2 runs and 1 comparison of experiment ${id}`,
        url,
        'press Ctrl-C to stop',
        '',
        'saved 1 review',
        `regenerate the report with them: placebo report ${id}`,
        '',
      ].join('\n'),
    );
    const store = await new SqliteRunStore(join(repo, '.placebo', 'runs')).open();
    try {
      expect((await store.listReviews()).map((saved) => saved.reviewer)).toEqual(['julien']);
    } finally {
      store.close();
    }
  }, 30_000);

  it('does not open a browser with --no-open', async () => {
    const id = await runOnce();
    const review = startReview([id, '--no-open']);
    await review.interrupt();
    const ran = await review.done;
    expect(ran.exitCode).toBe(0);
    expect(review.opened).toEqual([]);
    expect(ran.stdout).toContain(`reviewing 2 runs and 1 comparison of experiment ${id}`);
    expect(ran.stdout).toContain('saved 0 reviews');
  }, 30_000);

  it('exits 2 on an empty store or an unknown experiment', async () => {
    const empty = await placebo(['review', '--no-open'], where(), { reportTemplate: template });
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain('has no experiment yet; run placebo run first');
    const id = await runOnce();
    const unknown = await placebo(['review', 'nope', '--no-open'], where(), {
      reportTemplate: template,
    });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain(`the run store has no experiment nope; it has ${id}`);
  }, 30_000);
});
