// Embeds a fixture into the built dist/report.html, as the cli does with real results, and
// writes it to .preview/<fixture>.html for looking at in a browser. Build first.
// Usage: pnpm --filter @placebo-eval/report preview [rich|minimal]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { embedResults } from '../src/data/embed.js';

const name = process.argv[2] ?? 'rich';
const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const html = readFileSync(at('dist/report.html'), 'utf8');
const results: unknown = JSON.parse(readFileSync(at(`fixtures/${name}.json`), 'utf8'));
mkdirSync(at('.preview'), { recursive: true });
writeFileSync(at(`.preview/${name}.html`), embedResults(html, results));
process.stdout.write(`${at(`.preview/${name}.html`)}\n`);
