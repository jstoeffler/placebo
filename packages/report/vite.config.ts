import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { embedResults } from './src/data/embed.js';

const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

/**
 * `pnpm dev` only: embeds a fixture (`PLACEBO_FIXTURE=minimal` to switch; default `rich`) the way
 * the cli embeds real results, so the dev server shows a full report. With `review`
 * (`pnpm dev:review`) it embeds the review session in review mode and stands in for the review
 * server's API: answers are accepted and not kept, and finishing returns the rich results.
 */
function devFixture(): Plugin {
  const name = process.env.PLACEBO_FIXTURE ?? 'rich';
  const review = name === 'review';
  return {
    name: 'placebo-dev-fixture',
    apply: 'serve',
    transformIndexHtml(html) {
      const embedded = embedResults(html, fixtureJson(name));
      return review
        ? embedded.replace('id="placebo-results"', 'data-mode="review" id="placebo-results"')
        : embedded;
    },
    configureServer(server) {
      if (!review) return;
      server.middlewares.use('/api', (request, response) => {
        const send = (status: number, data: unknown) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(data));
        };
        const path = (request.url ?? '').split('?')[0];
        if (path === '/session') {
          const reviewer = new URL(request.url ?? '', 'http://dev').searchParams.get('reviewer');
          send(200, { ...(fixtureJson('review') as object), reviewer });
        } else if (path === '/answers' && request.method === 'POST') {
          send(200, { saved: true, remaining: 0 });
        } else if (path === '/finish' && request.method === 'POST') {
          send(200, fixtureJson('rich'));
        } else {
          send(404, { error: `no route ${request.method ?? ''} /api${path ?? ''}` });
        }
      });
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
