import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../src/audio.js';

test('blocked audio initialization leaves the game usable without constructing a real context', () => {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { throw new Error('Browser denied audio'); } };
  try {
    const audio = createAudio();
    assert.equal(audio.enabled, false);
    assert.equal(audio.toggle(), false);
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
    assert.equal(audio.toggle(), true);
    assert.doesNotThrow(() => audio.resume());
    await Promise.resolve();
    assert.equal(audio.toggle(), false);
  } finally { globalThis.AudioContext = previous; }
});

test('production entry point exposes no test-only global state', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /__swarmDebug|globalThis\.[A-Za-z_$][\w$]*\s*=/);
});
