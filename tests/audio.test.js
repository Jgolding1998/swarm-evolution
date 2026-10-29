import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../src/audio.js';

test('blocked audio initialization leaves the game usable without constructing a real context', async () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { throw new Error('Browser denied audio'); } };
  try {
    const audio = createAudio();
    assert.equal(audio.enabled, false);
    assert.equal(await audio.toggle(), false);
    assert.doesNotThrow(() => { audio.suspend(); audio.resume(); audio.play('shot'); });
  } finally { globalThis.AudioContext = previous; }
});

test('denied context transitions do not stop the game loop', async () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor() { this.state = 'suspended'; this.sampleRate = 8; this.currentTime = 1; }
    createGain() { return { gain: {}, connect() {} }; }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; }
    resume() { return Promise.reject(new Error('Denied')); }
    suspend() { throw new Error('Denied'); }
  };
  try {
    const audio = createAudio();
    assert.equal(await audio.toggle(), false);
    assert.equal(audio.enabled, false);
    assert.equal(await audio.resume(), false);
  } finally { globalThis.AudioContext = previous; }
});

function fakeContext() {
  const nodes = [];
  const node = () => {const n = {gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}},
    frequency: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect() {return this;},
    disconnect() {this.disconnected = true;}, start(time) {this.started = time;}, stop() {}}; nodes.push(n); return n;};
  return class {
    static nodes = nodes;
    constructor() {this.state = 'suspended'; this.sampleRate = 8000; this.currentTime = 0; this.destination = {};}
    createGain() {return node();} createOscillator() {return node();}
    createBuffer() {return {getChannelData: () => new Float32Array(4000)};}
    resume() {this.state = 'running'; return Promise.resolve();}
    suspend() {this.state = 'suspended'; return Promise.resolve();}
    close() {this.state = 'closed'; return Promise.resolve();}
  };
}

test('time-zero opt-in schedules a confirmation and voices stay capped and disconnect', async () => {
  const previous = globalThis.AudioContext, Fake = fakeContext(); globalThis.AudioContext = Fake;
  try {
    const audio = createAudio();
    assert.equal(await audio.toggle(), true);
    const sources = () => Fake.nodes.filter(n => n.started !== undefined);
    assert.equal(sources().length, 1, 'the first cue is not lost at context time zero');
    assert.equal(sources()[0].started, 0.02);
    for (let i = 0; i < 50; i++) audio.play('waveClear');
    assert.ok(sources().length <= 32);
    for (const source of sources()) source.onended();
    assert.ok(sources().every(n => n.disconnected));
    audio.play('extraLife');
    assert.equal(sources().length, 8, 'ended voices release their slots');
    assert.equal(await audio.toggle(), false);
  } finally {globalThis.AudioContext = previous;}
});

test('hiding during a delayed opt-in cannot turn sound on after the pause', async () => {
  const previous = globalThis.AudioContext, Fake = fakeContext();
  let finish, current; globalThis.AudioContext = class extends Fake {
    constructor() {super(); current = this;}
    resume() {return new Promise(resolve => {finish = () => {this.state = 'running'; resolve();};});}
  };
  try {
    const status = [], audio = createAudio(s => status.push(s));
    const pending = audio.toggle(); audio.suspend(); finish();
    assert.equal(await pending, false);
    assert.equal(audio.enabled, false); assert.equal(current.state, 'suspended');
    assert.equal(status.at(-1).busy, false); assert.equal(status.at(-1).kind, 'off');
  } finally {globalThis.AudioContext = previous;}
});

test('an unresolved browser resume expires and leaves a retryable off state', async t => {
  const previous = globalThis.AudioContext, Fake = fakeContext();
  globalThis.AudioContext = class extends Fake {resume() {return new Promise(() => {});}};
  t.mock.timers.enable({apis: ['setTimeout']});
  try {
    const status = [], audio = createAudio(s => status.push(s)), pending = audio.toggle();
    assert.equal(status.at(-1).busy, true);
    t.mock.timers.tick(3001);
    assert.equal(await pending, false);
    assert.equal(status.at(-1).kind, 'unavailable');
    assert.equal(status.at(-1).busy, false);
  } finally {globalThis.AudioContext = previous;}
});

test('an older resume completion cannot suspend a later successful sound retry', async () => {
  const previous = globalThis.AudioContext, Fake = fakeContext(), completions = [];
  let current;
  globalThis.AudioContext = class extends Fake {
    constructor() {super(); current = this;}
    resume() {return new Promise(resolve => completions.push(() => {this.state = 'running'; resolve();}));}
  };
  try {
    const audio = createAudio(), old = audio.toggle(); audio.suspend();
    const retry = audio.toggle(); completions[1]();
    assert.equal(await retry, true);
    completions[0](); await old;
    assert.equal(current.state, 'running'); assert.equal(audio.enabled, true);
  } finally {globalThis.AudioContext = previous;}
});

test('production entry point exposes no test-only global state', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /__swarmDebug|globalThis\.[A-Za-z_$][\w$]*\s*=/);
});
