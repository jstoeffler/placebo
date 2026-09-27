/**
 * Reads checklist questions from a markdown file: one question per list item (`- `, `* `, `+ `,
 * or numbered `1. ` / `1) `), with an optional `[ ]` checkbox stripped. Blank lines, headings and
 * any other text are ignored.
 */
export function parseQuestions(markdown: string): string[] {
  const questions: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line);
    if (item?.[1] !== undefined) questions.push(item[1]);
  }
  return questions;
}
