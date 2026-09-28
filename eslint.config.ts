import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.tsbuild/**',
      '.claude/worktrees/**',
      // Hidden tests of the dogfood suite call functions its tasks ask for; they exist only in runs.
      '.placebo/tasks/**',
      '.dependency-cruiser.cjs',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: false }],
      'no-console': 'error',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/src/testing/**'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['packages/report/src/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['scripts/**', 'packages/cli/src/index.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
