/** 32-bit FNV-1a hash of a string, used to seed the deterministic generator. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Small deterministic pseudo-random generator (mulberry32). The rules planner must give the same plan for the
 * same input, so every "random" choice comes from a generator seeded by the style, the take number and the clips.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotates an array left by k positions (k may exceed the length). */
export function rotate<T>(items: readonly T[], k: number): T[] {
  if (items.length === 0) return [];
  const n = ((k % items.length) + items.length) % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

/** Clamps n into [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Rounds to the given number of decimals (default 3). */
export function round(n: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
