import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('report build', () => {
  let outDir: string;
  let html: string;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'placebo-report-'));
    await build({ root, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
    html = await readFile(join(outDir, 'report.html'), 'utf8');
  }, 60_000);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('emits report.html and nothing else', async () => {
    expect(await readdir(outDir)).toEqual(['report.html']);
  });

  it('has no external src= or href= references', () => {
    // Inline script and style bodies are code, not markup; only tag attributes can load files.
    const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3');
    const references = [...markup.matchAll(/<[^>]+\s(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)].map(
      (match) => match[1],
    );
    expect(references).toEqual([]);
    expect(markup).not.toMatch(/<link\b/i);
  });

  it('inlines the application script', () => {
    expect(html).toMatch(/<script type="module"[^>]*>[\s\S]{1000,}<\/script>/);
    expect(html).toContain('No results embedded');
  });
});
