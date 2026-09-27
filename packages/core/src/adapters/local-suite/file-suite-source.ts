import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { SUITE_FILE, type SuiteSource } from '../../ports/suite-source.js';

/** A `SuiteSource` over a `.placebo/` directory on the local filesystem. */
export class FileSuiteSource implements SuiteSource {
  /** Absolute path of the suite folder. */
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async readSuiteYaml(): Promise<string> {
    return readFile(this.#resolve(SUITE_FILE), 'utf8');
  }

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.#resolve(path)));
  }

  async exists(path: string): Promise<boolean> {
    if (!this.#inside(path)) return false;
    try {
      return (await stat(resolve(this.dir, path))).isFile();
    } catch {
      return false;
    }
  }

  #inside(path: string): boolean {
    if (isAbsolute(path)) return false;
    const rel = relative(this.dir, resolve(this.dir, path));
    return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
  }

  #resolve(path: string): string {
    if (!this.#inside(path)) throw new Error(`${path} is outside the suite folder ${this.dir}`);
    return resolve(this.dir, path);
  }
}
