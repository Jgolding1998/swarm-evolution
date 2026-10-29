// Small seeded PRNG (mulberry32). State lives in a plain object so a
// whole simulation can be cloned, compared and replayed.

export function createRng(seed) {
  return { s: (seed >>> 0) || 0x9e3779b9 };
}

export function nextU32(rng) {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export function rand(rng) {
  return nextU32(rng) / 4294967296;
}

export function range(rng, lo, hi) {
  return lo + (hi - lo) * rand(rng);
}

export function randInt(rng, n) {
  return Math.floor(rand(rng) * n);
}

export function gauss(rng) {
  const u = Math.max(rand(rng), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand(rng));
}

// Turn arbitrary user text (for example a ?seed= value) into a 32-bit seed.
export function hashSeed(text) {
  let h = 0x811c9dc5;
  const str = String(text).slice(0, 64);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
