// Static checks on shipped files: no dynamic code, no HTML injection sinks,
// no network or device APIs, no remote assets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecord, loadBest, saveBest, clearBest, STORAGE_KEY, MAX_RAW } from '../src/storage.js';
import { createInput, isTypingTarget } from '../src/input.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcFiles = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.js')).map((f) => join('src', f));
const shipped = [...srcFiles, 'index.html', 'styles.css', 'assets/icon.svg'];

test('no eval, HTML sinks, network or device APIs in shipped code', () => {
  const banned = [/\beval\s*\(/, /new\s+Function\b/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\bfetch\s*\(/, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/, /getUserMedia|mediaDevices|geolocation/, /setTimeout\s*\(\s*['"`]/, /\bimport\s*\(/];
  for (const f of shipped) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const re of banned) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
});

test('no remote URLs in shipped files', () => {
  for (const f of shipped) {
    const text = readFileSync(join(root, f), 'utf8').replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '');
    assert.ok(!/https?:\/\//.test(text), f);
  }
});

test('page ships a strict CSP and only local module scripts', () => {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy" content="default-src 'self'; script-src 'self'/);
  assert.ok(!/<script(?![^>]*src="src\/main\.js")/.test(html), 'only the main module script');
  assert.ok(!/\son[a-z]+=/i.test(html), 'no inline handlers');
  assert.ok(!/style="/.test(html), 'no inline styles');
});

function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test('high score storage is schema-bound and size-limited', () => {
  assert.deepEqual(validateRecord({ v: 1, best: 10, wave: 2 }), { v: 1, best: 10, wave: 2 });
  for (const bad of [null, [], 'x', { v: 1, best: 10 }, { v: 2, best: 1, wave: 1 }, { v: 1, best: -1, wave: 1 }, { v: 1, best: 1.5, wave: 1 }, { v: 1, best: 1, wave: 1, name: 'me' }, { v: 1, best: 1e12, wave: 1 }, { v: 1, best: '5', wave: 1 }]) {
    assert.equal(validateRecord(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(loadBest(memStore({ [STORAGE_KEY]: '{"v":1,"best":5,"wave":2,"__proto__":{"x":1}}' })), { v: 1, best: 0, wave: 0 });
  assert.deepEqual(loadBest(memStore({ [STORAGE_KEY]: 'x'.repeat(MAX_RAW + 1) })), { v: 1, best: 0, wave: 0 });
  assert.deepEqual(loadBest(memStore({ [STORAGE_KEY]: '{not json' })), { v: 1, best: 0, wave: 0 });
  const s = memStore();
  saveBest(1200, 4, s);
  saveBest(800, 6, s);
  assert.deepEqual(JSON.parse(s.m.get(STORAGE_KEY)), { v: 1, best: 1200, wave: 6 });
  assert.equal([...s.m.keys()].length, 1);
  assert.ok(s.m.get(STORAGE_KEY).length <= MAX_RAW);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadBest(throwing), { v: 1, best: 0, wave: 0 });
  assert.doesNotThrow(() => saveBest(5, 1, throwing));
});

test('corrupt records are replaced safely and invalid saves preserve the last valid best', () => {
  const store = memStore({ [STORAGE_KEY]: '{broken', unrelated: 'keep' });
  assert.deepEqual(saveBest(42.9, 3.8, store), { v: 1, best: 42, wave: 3 });
  const raw = store.m.get(STORAGE_KEY);
  for (const [score, wave] of [[NaN, 4], [Infinity, 4], [100000000, 4], [50, 1000]]) {
    assert.deepEqual(saveBest(score, wave, store), { v: 1, best: 42, wave: 3 });
    assert.equal(store.m.get(STORAGE_KEY), raw);
  }
  assert.deepEqual(validateRecord({ v: 1, best: 99999999, wave: 999 }), { v: 1, best: 99999999, wave: 999 });
  clearBest(store);
  assert.equal(store.m.has(STORAGE_KEY), false);
  assert.equal(store.m.get('unrelated'), 'keep');
  assert.doesNotThrow(() => clearBest({ removeItem() { throw new Error('denied'); } }));
});

test('a browser that denies access to localStorage still supports load, save and clear', () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  try {
    assert.deepEqual(loadBest(), { v: 1, best: 0, wave: 0 });
    assert.deepEqual(saveBest(10, 2), { v: 1, best: 10, wave: 2 });
    assert.doesNotThrow(() => clearBest());
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});

test('keys typed into form fields are left alone', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'textarea' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'CANVAS' }), false);
  assert.equal(isTypingTarget(null), false);
});

// Small event targets exercise the input contract without a browser or devices.
function inputFixture(run) {
  function target(extra = {}) {
    const listeners = new Map();
    return {
      ...extra,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      emit(type, props = {}) {
        const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props };
        for (const handler of listeners.get(type) || []) handler(ev);
        return ev;
      },
    };
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const commands = [];
  const captures = [];
  const canvas = target({ tagName: 'CANVAS', setPointerCapture(id) { captures.push(id); }, focus() {} });
  const fakeWindow = target();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  try {
    const input = createInput({ canvas, toWorldX: (x) => x * 2, onCommand: (cmd) => commands.push(cmd) });
    run({ input, canvas, fakeWindow, commands, captures });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
}

test('pointer capture loss and cancellation release firing and movement', () => {
  inputFixture(({ input, canvas }) => {
    for (const end of ['lostpointercapture', 'pointercancel', 'pointerup']) {
      canvas.emit('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 100 });
      assert.deepEqual(input.sample(), { left: false, right: false, fire: true, pointerX: 200 });
      canvas.emit(end, { pointerId: 1 });
      canvas.emit('pointermove', { pointerId: 1, clientX: 300 });
      assert.deepEqual(input.sample(), { left: false, right: false, fire: false, pointerX: null });
    }
  });
});

test('held activation repeats cannot click a newly focused overlay button', () => {
  inputFixture(({fakeWindow, commands}) => {
    for (const code of ['Space', 'Enter']) {
      const repeated = fakeWindow.emit('keydown', {code, repeat: true, target: {tagName: 'BUTTON'}});
      assert.equal(repeated.defaultPrevented, true);
      const fresh = fakeWindow.emit('keydown', {code, repeat: false, target: {tagName: 'BUTTON'}});
      assert.equal(fresh.defaultPrevented, false, 'fresh button activation stays native');
    }
    assert.deepEqual(commands, []);
  });
});

test('the first pointer owns a drag and secondary mouse buttons do not fire', () => {
  inputFixture(({ input, canvas, commands, captures }) => {
    for (const button of [1, 2]) canvas.emit('pointerdown', { pointerType: 'mouse', pointerId: button, button, clientX: 80 });
    assert.equal(input.sample().fire, false);
    assert.deepEqual(commands, []);
    canvas.emit('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 50 });
    canvas.emit('pointerdown', { pointerType: 'touch', pointerId: 8, clientX: 250 });
    canvas.emit('pointermove', { pointerId: 8, clientX: 400 });
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.emit(end, { pointerId: 8 });
    assert.deepEqual(input.sample(), { left: false, right: false, fire: true, pointerX: 100 });
    assert.deepEqual(captures, [7]);
    assert.deepEqual(commands, ['launch']);
    canvas.emit('pointermove', { pointerId: 7, clientX: 75 });
    assert.equal(input.sample().pointerX, 150);
    canvas.emit('pointerup', { pointerId: 7 });
    assert.equal(input.sample().fire, false);
    canvas.emit('pointerdown', { pointerType: 'mouse', pointerId: 9, button: 0, clientX: 60 });
    assert.equal(input.sample().fire, true, 'a new primary pointer works after release');
  });
});

test('blur and reset clear all held controls; keyboard takes over pointer movement', () => {
  inputFixture(({ input, canvas, fakeWindow }) => {
    canvas.emit('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 70 });
    fakeWindow.emit('keydown', { code: 'ArrowLeft', target: canvas });
    assert.equal(input.sample().left, true);
    assert.equal(input.sample().pointerX, null);
    fakeWindow.emit('blur');
    assert.deepEqual(input.sample(), { left: false, right: false, fire: false, pointerX: null });
    fakeWindow.emit('keydown', { code: 'KeyD', target: canvas });
    fakeWindow.emit('keydown', { code: 'KeyJ', target: canvas });
    input.clear();
    assert.deepEqual(input.sample(), { left: false, right: false, fire: false, pointerX: null });
  });
});
