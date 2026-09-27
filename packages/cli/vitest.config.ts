import { defineProject } from 'vitest/config';

export default defineProject({
  define: { __PLACEBO_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    name: 'cli',
    include: ['src/**/*.test.ts'],
  },
});
