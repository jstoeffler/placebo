import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', '**/src/testing/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        'packages/core/src/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  },
});
