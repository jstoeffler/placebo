/**
 * A seeded source of randomness. Everything random in Placebo (run order, comparison pairing,
 * `a`/`b` positions, resampling) draws from a `Random` so an experiment replays exactly from its
 * seed.
 */
export interface Random {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [min, max). Throws if the interval is empty. */
  int(min: number, max: number): number;
  /** A shuffled copy; the input is not modified. */
  shuffle<T>(items: readonly T[]): T[];
}

/** Largest accepted seed; seeds are unsigned 32-bit integers. */
export const MAX_SEED = 0xffff_ffff;

/**
 * Deterministic `Random` using mulberry32. Not cryptographic; good enough for resampling and
 * shuffling, fast, and identical on every platform.
 */
export function createSeededRandom(seed: number): Random {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    throw new RangeError(
      `seed must be an integer in [0, ${String(MAX_SEED)}], got ${String(seed)}`,
    );
  }
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
      throw new RangeError(`int(${String(min)}, ${String(max)}): need integers with min < max`);
    }
    return min + Math.floor(next() * (max - min));
  };
  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = int(0, i + 1);
        const a = copy[i] as T;
        copy[i] = copy[j] as T;
        copy[j] = a;
      }
      return copy;
    },
  };
}
