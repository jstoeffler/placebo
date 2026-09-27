import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSuiteSource } from './file-suite-source.js';

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'placebo-suite-source-'));
  dir = join(root, '.placebo');
  await mkdir(join(dir, 'variants'), { recursive: true });
  await writeFile(join(dir, 'suite.yaml'), 'commit: "0123456"\n');
  await writeFile(join(dir, 'variants', 'none.patch'), new Uint8Array([0xff, 0x00, 0x41]));
  await writeFile(join(root, 'secret.txt'), 'outside');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileSuiteSource', () => {
  it('reads suite.yaml as text and files as unchanged bytes', async () => {
    const source = new FileSuiteSource(dir);
    expect(source.dir).toBe(dir);
    await expect(source.readSuiteYaml()).resolves.toBe('commit: "0123456"\n');
    await expect(source.readFile('variants/none.patch')).resolves.toEqual(
      new Uint8Array([0xff, 0x00, 0x41]),
    );
  });

  it('says a path exists only for a regular file inside the suite folder', async () => {
    const source = new FileSuiteSource(dir);
    await expect(source.exists('variants/none.patch')).resolves.toBe(true);
    await expect(source.exists('variants')).resolves.toBe(false);
    await expect(source.exists('variants/missing.patch')).resolves.toBe(false);
    await expect(source.exists('../secret.txt')).resolves.toBe(false);
    await expect(source.exists(join(root, 'secret.txt'))).resolves.toBe(false);
    await expect(source.exists('.')).resolves.toBe(false);
  });

  it('rejects reads of missing files and of paths outside the suite folder', async () => {
    const source = new FileSuiteSource(dir);
    await expect(source.readFile('variants/missing.patch')).rejects.toThrow('ENOENT');
    await expect(source.readFile('../secret.txt')).rejects.toThrow(
      `../secret.txt is outside the suite folder ${dir}`,
    );
    await rm(join(dir, 'suite.yaml'));
    await expect(source.readSuiteYaml()).rejects.toThrow('ENOENT');
  });
});
