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
  // Core, zod and yaml are bundled; the output may import only node built-ins and the packages
  // declared in `dependencies`, and the build fails otherwise.
  deps: {
    onlyBundle: ['zod', 'yaml'],
    onlyImport: ['commander', 'picocolors', '@anthropic-ai/claude-agent-sdk'],
  },
  copy: [{ from: '../report/dist/report.html', to: 'dist' }, '../../LICENSE'],
});
