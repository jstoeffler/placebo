// Runs before every cli test file: HOME and PLACEBO_HOME point at a fresh temporary directory,
// removed after the file, so no test (in-process or spawned) can write snapshots or run folders
// under the real `~/.placebo`, even one that forgets to pass its own home.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const saved = { HOME: process.env.HOME, PLACEBO_HOME: process.env.PLACEBO_HOME };
const home = realpathSync(mkdtempSync(join(tmpdir(), 'placebo-test-home-')));
process.env.HOME = home;
process.env.PLACEBO_HOME = join(home, '.placebo');

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  rmSync(home, { recursive: true, force: true });
});
