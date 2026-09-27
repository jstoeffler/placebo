import { describe, expect, it } from 'vitest';
import { isConfigurationSurface, outsideConfigurationSurface, patchPaths } from './patch-paths.js';

const edit = `diff --git a/CLAUDE.md b/CLAUDE.md
index 1111111..2222222 100644
--- a/CLAUDE.md
+++ b/CLAUDE.md
@@ -1,3 +1,3 @@
 # Rules
--- this removed line is not a header
+++ neither is this added line
`;

const add = `diff --git a/.claude/rules/new.md b/.claude/rules/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/.claude/rules/new.md
@@ -0,0 +1 @@
+hello
`;

const remove = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
\\ No newline at end of file
`;

const rename = `diff --git a/docs/a guide.md b/docs/b guide.md
similarity index 90%
rename from docs/a guide.md
rename to docs/b guide.md
index 5555555..6666666 100644
--- a/docs/a guide.md
+++ b/docs/b guide.md
@@ -1 +1 @@
-old
+new
`;

const pureRename = `diff --git a/x.md b/y.md
similarity index 100%
rename from x.md
rename to y.md
`;

const quoted = `diff --git "a/caf\\303\\251 \\"menu\\".md" "b/caf\\303\\251 \\"menu\\".md"
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ "b/caf\\303\\251 \\"menu\\".md"
@@ -0,0 +1 @@
+x
`;

const binary = `diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..8888888
Binary files /dev/null and b/img/logo.png differ
`;

const modeOnly = `diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
`;

const quotedHeaderOnly = `diff --git "a/tab\\there.bin" "b/tab\\there.bin"
new file mode 100644
index 0000000..9999999
Binary files /dev/null and "b/tab\\there.bin" differ
`;

const mixedHeaderOnly = `diff --git a/plain.bin "b/sp\\303\\251cial.bin"
similarity index 100%
`;

const unifiedWithTimestamps = `--- a/notes.txt\t2026-09-27 10:00:00.000000000 +0200
+++ b/notes.txt\t2026-09-27 10:01:00.000000000 +0200
@@ -1 +1,2 @@
 keep
+added
`;

describe('patchPaths', () => {
  it('reads edited paths and ignores header-like lines inside hunks', () => {
    expect(patchPaths(edit)).toEqual(['CLAUDE.md']);
  });

  it('reads the one real path of adds and deletes', () => {
    expect(patchPaths(add + remove)).toEqual(['.claude/rules/new.md', 'src/old.ts']);
  });

  it('reads both sides of a rename, with spaces in paths', () => {
    expect(patchPaths(rename)).toEqual(['docs/a guide.md', 'docs/b guide.md']);
    expect(patchPaths(pureRename)).toEqual(['x.md', 'y.md']);
  });

  it('decodes quoted paths with octal UTF-8 and escapes', () => {
    expect(patchPaths(quoted)).toEqual(['café "menu".md']);
    expect(patchPaths(quotedHeaderOnly)).toEqual(['tab\there.bin']);
  });

  it('falls back to the diff --git line for binary and mode-only sections', () => {
    expect(patchPaths(binary + modeOnly)).toEqual(['img/logo.png', 'scripts/run.sh']);
    expect(patchPaths(mixedHeaderOnly)).toEqual(['plain.bin', 'spécial.bin']);
  });

  it('reads plain unified diffs with timestamps', () => {
    expect(patchPaths(unifiedWithTimestamps)).toEqual(['notes.txt']);
  });

  it('returns sorted unique paths and nothing for an empty patch', () => {
    expect(patchPaths(edit + add + edit)).toEqual(['.claude/rules/new.md', 'CLAUDE.md']);
    expect(patchPaths('')).toEqual([]);
  });

  it('gives up on an ambiguous asymmetric unquoted header', () => {
    expect(patchPaths('diff --git a/one b/two\nold mode 100644\n')).toEqual([]);
  });
});

describe('configuration surface', () => {
  it('accepts the documented paths', () => {
    for (const path of [
      'CLAUDE.md',
      'AGENTS.md',
      'CLAUDE.local.md',
      '.mcp.json',
      '.claude/settings.json',
      '.claude/hooks/pre.sh',
      'packages/api/CLAUDE.md',
      'docs/AGENTS.md',
    ]) {
      expect(isConfigurationSurface(path), path).toBe(true);
    }
  });

  it('lists everything else as outside, in input order', () => {
    expect(
      outsideConfigurationSurface([
        'src/index.ts',
        'CLAUDE.md',
        'claude.md',
        'docs/CLAUDE.local.md',
        'CONTEXT.md',
        'sub/.mcp.json',
        '.claude/agents/x.md',
      ]),
    ).toEqual(['src/index.ts', 'claude.md', 'docs/CLAUDE.local.md', 'CONTEXT.md', 'sub/.mcp.json']);
  });
});
