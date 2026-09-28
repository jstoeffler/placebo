/** Where saving one answer stands. */
export type SaveState =
  | { readonly type: 'idle' }
  | { readonly type: 'saving' }
  | { readonly type: 'failed'; readonly message: string };

export const IDLE: SaveState = { type: 'idle' };

/** True when a key press is text being typed, which review shortcuts must leave alone. */
export function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && target.type !== 'radio';
}
