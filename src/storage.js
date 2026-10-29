// Optional local scores. Legacy records stay separate because older versions
// mixed evolving and control runs. New runs use six fixed mode/rules keys.

import { runMode } from './modes.js';

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

export function modeStorageKey(mode, evolve = true) {
  return `swarm-evolution.best.v2.${runMode(mode)}.${evolve ? 'evolving' : 'control'}`;
}

function validateModeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'best,v,wave' || value.v !== 2) return null;
  if (![value.best, value.wave].every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return {v: 2, best: value.best, wave: value.wave};
}

export function loadModeBest(mode, evolve = true, store) {
  const empty = {v: 2, best: 0, wave: 0};
  try {
    const raw = getStore(store)?.getItem(modeStorageKey(mode, evolve));
    return typeof raw === 'string' && raw.length <= MAX_RAW ? validateModeRecord(JSON.parse(raw)) || empty : empty;
  } catch { return empty; }
}

export function saveModeBest(score, wave, mode, evolve = true, store) {
  const s = getStore(store), previous = loadModeBest(mode, evolve, s);
  const next = validateModeRecord({v: 2, best: Math.max(previous.best, Math.floor(score)), wave: Math.max(previous.wave, Math.floor(wave))});
  if (!next) return previous;
  try { s?.setItem(modeStorageKey(mode, evolve), JSON.stringify(next)); } catch { /* Optional storage. */ }
  return next;
}

export function createScoreSession(store) {
  const records = new Map();
  function remember(mode, evolve, value) {
    const key = modeStorageKey(mode, evolve);
    const previous = records.get(key) || {v: 2, best: 0, wave: 0};
    const next = {v: 2, best: Math.max(previous.best, value.best), wave: Math.max(previous.wave, value.wave)};
    records.set(key, next);
    return {...next};
  }
  function load(mode, evolve = true) {
    return remember(mode, evolve, loadModeBest(mode, evolve, store));
  }
  function save(score, wave, mode, evolve = true) {
    const previous = load(mode, evolve);
    return remember(mode, evolve, saveModeBest(Math.max(previous.best, score), Math.max(previous.wave, wave), mode, evolve, store));
  }
  return {load, save};
}
