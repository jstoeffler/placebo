import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node26',
  dts: false,
  fixedExtension: false,
  clean: true,
  define: { __PLACEBO_VERSION__: JSON.stringify(pkg.version) },
  // Core (and its zod/yaml) is bundled; runtime dependencies of placebo-eval stay external.
  copy: [{ from: '../report/dist/report.html', to: 'dist' }],
});
