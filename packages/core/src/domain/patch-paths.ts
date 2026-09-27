/**
 * Paths a variant patch touches, relative to the repo root, sorted and unique.
 *
 * Reads `--- a/…` and `+++ b/…` headers (skipping `/dev/null`, so adds and deletes yield their one
 * real path), `rename from/to` and `copy from/to` lines (so a rename yields both paths), and falls
 * back to the `diff --git` line for sections without them (binary files, mode changes, empty
 * files). Handles git's C-style quoted paths. Hunk bodies are skipped by their line counts, so a
 * removed line such as `-- comment` is never read as a header.
 */
export function patchPaths(patch: string): string[] {
  const paths = new Set<string>();
  let section: { header: string[]; found: string[] } | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const closeSection = (): void => {
    if (section === undefined) return;
    const chosen = section.found.length > 0 ? section.found : section.header;
    for (const path of chosen) paths.add(path);
    section = undefined;
  };

  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-')) oldLeft--;
      else if (line.startsWith('+')) newLeft--;
      else if (!line.startsWith('\\')) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk !== null) {
      oldLeft = Number(hunk[1] ?? '1');
      newLeft = Number(hunk[2] ?? '1');
      continue;
    }
    if (line.startsWith('diff --git ')) {
      closeSection();
      section = { header: gitHeaderPaths(line.slice('diff --git '.length)), found: [] };
      continue;
    }
    const target = section ?? (section = { header: [], found: [] });
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = headerPath(line.slice(4));
      if (path !== undefined) target.found.push(path);
      continue;
    }
    const extended = /^(?:rename|copy) (?:from|to) (.*)$/.exec(line);
    if (extended?.[1] !== undefined) target.found.push(readPath(extended[1]));
  }
  closeSection();
  return [...paths].sort(compareStrings);
}

/**
 * Files a variant patch is expected to touch: `CLAUDE.md`, `AGENTS.md`, `CLAUDE.local.md` and
 * `.mcp.json` at the root, anything under `.claude/`, and any `CLAUDE.md` or `AGENTS.md` in a
 * subdirectory. Matching is exact and case-sensitive.
 */
export function isConfigurationSurface(path: string): boolean {
  if (ROOT_SURFACE.has(path) || path.startsWith('.claude/')) return true;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename === 'CLAUDE.md' || basename === 'AGENTS.md';
}

/** The paths outside the configuration surface, in input order; each one earns a warning. */
export function outsideConfigurationSurface(paths: readonly string[]): string[] {
  return paths.filter((path) => !isConfigurationSurface(path));
}

const ROOT_SURFACE = new Set(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md', '.mcp.json']);

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The path of a `---`/`+++` header without its `a/`/`b/` prefix; undefined for `/dev/null`. */
function headerPath(raw: string): string | undefined {
  const value = raw.startsWith('"') ? readQuoted(raw).value : (raw.split('\t')[0] ?? '').trimEnd();
  if (value === '/dev/null') return undefined;
  return stripPrefix(value);
}

function stripPrefix(path: string): string {
  const slash = path.indexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function readPath(raw: string): string {
  return raw.startsWith('"') ? readQuoted(raw).value : raw;
}

/** Paths from `a/<old> b/<new>`: exact when quoted or when both sides are the same path. */
function gitHeaderPaths(rest: string): string[] {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    const second = readPath(first.rest.trimStart());
    return [stripPrefix(first.value), stripPrefix(second)];
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond !== -1) {
    return [
      stripPrefix(rest.slice(0, quotedSecond)),
      stripPrefix(readPath(rest.slice(quotedSecond + 1))),
    ];
  }
  // Unquoted `a/P b/P`: the two halves have the same length, so split in the middle.
  const half = (rest.length - 1) / 2;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);
  if (Number.isInteger(half) && stripPrefix(left) === stripPrefix(right)) {
    return [stripPrefix(left)];
  }
  return [];
}

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
};

/** Decodes a git C-style quoted string (octal escapes are UTF-8 bytes). */
function readQuoted(raw: string): { value: string; rest: string } {
  const bytes: number[] = [];
  let index = 1;
  for (let char = raw[index]; char !== undefined && char !== '"'; char = raw[index]) {
    if (char === '\\') {
      const next = raw[index + 1] ?? '';
      const octal = /^[0-7]{3}/.exec(raw.slice(index + 1));
      if (octal !== null) {
        bytes.push(parseInt(octal[0], 8));
        index += 4;
        continue;
      }
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      index += 2;
      continue;
    }
    const text = String.fromCodePoint(raw.codePointAt(index) ?? 0);
    bytes.push(...Buffer.from(text, 'utf8'));
    index += text.length;
  }
  return { value: Buffer.from(bytes).toString('utf8'), rest: raw.slice(index + 1) };
}
