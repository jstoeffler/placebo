import { createHash } from 'node:crypto';
import type { Sha256 } from './ids.js';

/**
 * Serializes a JSON-compatible value with object keys sorted at every depth and no whitespace,
 * so two values that are equal as data always produce the same string.
 *
 * Properties whose value is `undefined` are omitted, like `JSON.stringify`. Anything that is not
 * representable in JSON (non-finite numbers, bigint, functions, symbols, `undefined` at the top
 * level or inside arrays) throws, because silently coercing it would make two different values
 * hash the same.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => serialize(item, `${path}[${String(index)}]`)).join(',')}]`;
      }
      if (value instanceof Uint8Array) {
        throw new TypeError(`canonicalJson: bytes at ${path}; hash them with sha256 first`);
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/** SHA-256 of a string (as UTF-8) or of raw bytes, as lowercase hex. */
export function sha256(data: string | Uint8Array): Sha256 {
  return createHash('sha256').update(data).digest('hex') as Sha256;
}

/** SHA-256 of the canonical JSON of a value: equal data, equal hash, regardless of key order. */
export function hashCanonical(value: unknown): Sha256 {
  return sha256(canonicalJson(value));
}
