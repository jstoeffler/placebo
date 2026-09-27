import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical, sha256 } from './hash.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops undefined properties', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('é"')).toBe('"é\\""');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(-0.5)).toBe('-0.5');
  });

  it.each([
    [Number.NaN, 'non-finite number at $'],
    [{ a: [Infinity] }, 'non-finite number at $.a[0]'],
    [{ a: 1n }, 'unsupported bigint at $.a'],
    [[undefined], 'unsupported undefined at $[0]'],
    [{ f: () => 1 }, 'unsupported function at $.f'],
    [{ b: new Uint8Array(1) }, 'bytes at $.b'],
  ])('rejects %o', (value, message) => {
    expect(() => canonicalJson(value)).toThrow(message);
  });
});

describe('hashCanonical', () => {
  it('is independent of key order', () => {
    const a = { x: 1, y: { p: 'q', r: [1, 2] } };
    const b = { y: { r: [1, 2], p: 'q' }, x: 1 };
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it('depends on array order and values', () => {
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: '1' }));
  });
});

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes strings as UTF-8, equal to their bytes', () => {
    expect(sha256('héllo')).toBe(sha256(new TextEncoder().encode('héllo')));
  });
});
