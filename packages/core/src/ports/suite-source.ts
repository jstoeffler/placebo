/** The suite's own file, relative to the suite folder. */
export const SUITE_FILE = 'suite.yaml';

/**
 * Read access to a suite folder, `.placebo/` (implementations: the local filesystem; tests may
 * use a map).
 *
 * Contract:
 * - Every path is relative to the suite folder and `/`-separated, such as `variants/none.patch`.
 *   A path that is absolute or leaves the suite folder is refused: `exists` resolves false and
 *   `readFile` rejects.
 * - `readSuiteYaml` resolves with the text of `suite.yaml`; it rejects when the file is missing.
 * - `readFile` resolves with the file's bytes, unchanged; it rejects when the file is missing.
 * - `exists` resolves true only for a regular file.
 */
export interface SuiteSource {
  readSuiteYaml(): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
}
