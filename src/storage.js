// Optional local best score. Only two integers are ever stored, under one
// key, and anything that does not match the schema exactly is discarded.

export const STORAGE_KEY = 'swarm-evolution.best.v1';
export const MAX_RAW = 96;
const EMPTY = Object.freeze({ v: 1, best: 0, wave: 0 });

export function validateRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = Object.keys(obj).sort();
  if (keys.length !== 3 || keys[0] !== 'best' || keys[1] !== 'v' || keys[2] !== 'wave') return null;
  if (obj.v !== 1) return null;
  if (!Number.isSafeInteger(obj.best) || obj.best < 0 || obj.best > 99999999) return null;
  if (!Number.isSafeInteger(obj.wave) || obj.wave < 0 || obj.wave > 999) return null;
  return { v: 1, best: obj.best, wave: obj.wave };
}

function getStore(store) {
  if (store) return store;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // storage disabled by the browser
  }
}

export function loadBest(store) {
  const s = getStore(store);
  if (!s) return { ...EMPTY };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length > MAX_RAW) return { ...EMPTY };
    return validateRecord(JSON.parse(raw)) || { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

export function saveBest(score, wave, store) {
  const s = getStore(store);
  const prev = loadBest(s);
  const next = validateRecord({ v: 1, best: Math.max(prev.best, Math.floor(score)), wave: Math.max(prev.wave, Math.floor(wave)) });
  if (!next || !s) return next || prev;
  const raw = JSON.stringify(next);
  if (raw.length > MAX_RAW) return prev;
  try {
    s.setItem(STORAGE_KEY, raw);
  } catch {
    // Quota or privacy mode: the game works the same without it.
  }
  return next;
}

export function clearBest(store) {
  const s = getStore(store);
  try {
    if (s) s.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
