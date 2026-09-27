import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSuiteSource } from '../adapters/local-suite/file-suite-source.js';
import { hashSuite } from '../domain/run-key.js';
import { TempDirs } from '../testing/grading.js';
import { loadSuite } from './load-suite.js';

/** Brief Appendix A. */
const APPENDIX_A = `# .placebo/suite.yaml
repo: .
commit: 3f9a1c2e
model: claude-sonnet-5            # written by init from your current default
judge_model: claude-opus-5-5      # written by init from the current Opus
runs: 5
parallelism: 4
setup: pnpm install --frozen-lockfile

variants:
  none:   { patch: variants/none.patch }
  tests:  { patch: variants/always-run-tests.patch }

tasks:
  - id: refund-rounding
    prompt: |
      Refunds of 10.005 are rounded to 10.00 instead of 10.01.
      Fix the rounding. \`refund(amount)\` in src/money.ts must keep its signature.
    graders:
      - { type: command, run: "pnpm vitest run tests/hidden/refund.spec.ts", hidden: [tests/hidden/refund.spec.ts] }
      - { type: file_modified, path: src/money.ts }
      - { type: checklist, questions: tasks/refund-rounding/checklist.md }
      - { type: comparison }
    review:
      questions: tasks/refund-rounding/checklist.md
`;

const FILES: Record<string, string> = {
  'suite.yaml': APPENDIX_A,
  'variants/none.patch': 'diff --git a/CLAUDE.md b/CLAUDE.md\ndeleted file mode 100644\n',
  'variants/always-run-tests.patch':
    '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1,2 @@\n x\n+Always run tests.\n',
  'tasks/refund-rounding/tests/hidden/refund.spec.ts': 'test("refund", () => {});\n',
  'tasks/refund-rounding/checklist.md': '- Rounds half up?\n- Keeps the signature?\n',
};

const temp = new TempDirs();
afterEach(() => temp.cleanup());

async function suiteDir(files: Record<string, string | undefined> = FILES): Promise<string> {
  const dir = join(await temp.create('placebo-suite-'), '.placebo');
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe('loadSuite', () => {
  it('parses the suite and reads every file it references, once', async () => {
    const loaded = await loadSuite(new FileSuiteSource(await suiteDir()));
    if (!loaded.ok) throw new Error(loaded.error.message);
    const { suite, files, suiteHash } = loaded.value;
    expect(suite.commit).toBe('3f9a1c2e');
    expect(Object.keys(suite.variants)).toEqual(['none', 'tests']);
    expect([...files.keys()]).toEqual([
      'variants/none.patch',
      'variants/always-run-tests.patch',
      'tasks/refund-rounding/tests/hidden/refund.spec.ts',
      'tasks/refund-rounding/checklist.md',
    ]);
    expect(new TextDecoder().decode(files.get('tasks/refund-rounding/checklist.md'))).toBe(
      FILES['tasks/refund-rounding/checklist.md'],
    );
    expect(suiteHash).toBe(hashSuite(suite, files));
  });

  it('gives the same suite hash for the same content in another folder', async () => {
    const a = await loadSuite(new FileSuiteSource(await suiteDir()));
    const b = await loadSuite(new FileSuiteSource(await suiteDir()));
    const changed = await loadSuite(
      new FileSuiteSource(
        await suiteDir({ ...FILES, 'tasks/refund-rounding/checklist.md': '- Other?\n' }),
      ),
    );
    if (!a.ok || !b.ok || !changed.ok) throw new Error('expected every suite to load');
    expect(a.value.suiteHash).toBe(b.value.suiteHash);
    expect(changed.value.suiteHash).not.toBe(a.value.suiteHash);
  });

  it('names every missing file with what refers to it', async () => {
    const dir = await suiteDir({
      ...FILES,
      'tasks/refund-rounding/tests/hidden/refund.spec.ts': undefined,
      'variants/none.patch': undefined,
    });
    const loaded = await loadSuite(new FileSuiteSource(dir));
    expect(loaded).toEqual({
      ok: false,
      error: {
        type: 'missing_files',
        files: [
          {
            path: 'variants/none.patch',
            referencedBy: 'patch of variant "none"',
            problem: 'missing',
          },
          {
            path: 'tasks/refund-rounding/tests/hidden/refund.spec.ts',
            referencedBy: 'hidden file of task "refund-rounding", tasks[0].graders[0]',
            problem: 'missing',
          },
        ],
        message: [
          'variants/none.patch does not exist (patch of variant "none")',
          'tasks/refund-rounding/tests/hidden/refund.spec.ts does not exist (hidden file of task "refund-rounding", tasks[0].graders[0])',
        ].join('\n'),
      },
    });
  });

  it('reports a file referenced twice once, and review questions on their own', async () => {
    const yaml = APPENDIX_A.replace(
      'questions: tasks/refund-rounding/checklist.md\n',
      'questions: tasks/refund-rounding/review.md\n',
    ).replace(
      'checklist, questions: tasks/refund-rounding/checklist.md',
      'checklist, questions: tasks/refund-rounding/review.md',
    );
    const loaded = await loadSuite(
      new FileSuiteSource(await suiteDir({ ...FILES, 'suite.yaml': yaml })),
    );
    expect(loaded.ok ? undefined : loaded.error).toMatchObject({
      type: 'missing_files',
      files: [
        {
          path: 'tasks/refund-rounding/review.md',
          referencedBy: 'checklist questions of task "refund-rounding", tasks[0].graders[2]',
        },
      ],
    });

    const reviewOnly = APPENDIX_A.replace(
      '    review:\n      questions: tasks/refund-rounding/checklist.md\n',
      '    review:\n      questions: tasks/refund-rounding/review.md\n',
    );
    const review = await loadSuite(
      new FileSuiteSource(await suiteDir({ ...FILES, 'suite.yaml': reviewOnly })),
    );
    expect(review.ok ? undefined : review.error.message).toBe(
      'tasks/refund-rounding/review.md does not exist (review questions of task "refund-rounding", tasks[0].review)',
    );
  });

  it('refuses a referenced path outside .placebo/', async () => {
    const yaml = APPENDIX_A.replace('variants/none.patch', '../none.patch');
    const loaded = await loadSuite(
      new FileSuiteSource(await suiteDir({ ...FILES, 'suite.yaml': yaml })),
    );
    expect(loaded.ok ? undefined : loaded.error.message).toBe(
      '../none.patch is outside the suite folder .placebo/ (patch of variant "none")',
    );
    const absolute = APPENDIX_A.replace('variants/none.patch', '/etc/none.patch');
    const refused = await loadSuite(
      new FileSuiteSource(await suiteDir({ ...FILES, 'suite.yaml': absolute })),
    );
    expect(refused.ok ? undefined : refused.error.type).toBe('missing_files');
  });

  it('fails when suite.yaml is missing or invalid', async () => {
    const missing = await loadSuite(
      new FileSuiteSource(await suiteDir({ ...FILES, 'suite.yaml': undefined })),
    );
    expect(missing).toEqual({
      ok: false,
      error: { type: 'suite_missing', message: 'suite.yaml does not exist' },
    });

    const invalid = await loadSuite(
      new FileSuiteSource(
        await suiteDir({ ...FILES, 'suite.yaml': APPENDIX_A.replace('runs: 5', 'runs: 0') }),
      ),
    );
    expect(invalid.ok ? undefined : invalid.error).toMatchObject({
      type: 'invalid_suite',
      issues: [{ path: 'runs', line: 6 }],
      message: expect.stringMatching(/^suite\.yaml:6 runs: /) as unknown,
    });
  });
});
