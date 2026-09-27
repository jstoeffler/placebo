import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { embedResults } from './src/data/embed.js';

/**
 * `pnpm dev` only: embeds a fixture (`PLACEBO_FIXTURE=minimal` to switch; default `rich`) the way
 * the cli embeds real results, so the dev server shows a full report.
 */
function devFixture(): Plugin {
  return {
    name: 'placebo-dev-fixture',
    apply: 'serve',
    transformIndexHtml(html) {
      const name = process.env.PLACEBO_FIXTURE ?? 'rich';
      const url = new URL(`fixtures/${name}.json`, import.meta.url);
      return embedResults(html, JSON.parse(readFileSync(url, 'utf8')));
    },
  };
}

// Builds dist/report.html: one file, every script and style inlined, no external references.
export default defineConfig({
  plugins: [react(), viteSingleFile(), devFixture()],
  build: {
    rollupOptions: { input: 'report.html' },
  },
  server: { open: '/report.html' },
});
