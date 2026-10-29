import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame, startGame, restartGame, step, drainEvents, setPaused, DT, CONFIG} from '../src/sim.js';
import {RUN_MODES, runMode} from '../src/modes.js';
import {loadBest, loadModeBest, saveModeBest, modeStorageKey, STORAGE_KEY} from '../src/storage.js';
import {createBot} from '../tools/bot.js';

test('campaigns share the original endless simulation until their final clear, then freeze', () => {
  for (const mode of ['campaign', 'extended']) {
    const states = [mode, 'endless'].map(runMode => startGame(createGame({seed: 34, runMode})));
    for (let wave = 1; wave <= RUN_MODES[mode].waves; wave++) {
      const bot = createBot('skilled');
      for (let tick = 0; tick < 120; tick++) {
        const input = bot(states[0]);
        for (const s of states) step(s, input);
        const copies = states.map(s => {const copy = structuredClone(s); delete copy.runMode; return copy;});
        assert.deepEqual(copies[0], copies[1]);
      }
      for (const s of states) {s.enemies.length = s.shots.length = 0; step(s);}
      if (wave < RUN_MODES[mode].waves) {
        for (let i = 0; i < Math.ceil(CONFIG.intermission / DT) + 1; i++) for (const s of states) step(s);
      }
    }
    const [campaign, endless] = states;
    assert.equal(campaign.phase, 'won'); assert.equal(endless.phase, 'intermission');
    assert.equal(campaign.score, endless.score);
    assert.equal(drainEvents(campaign).filter(e => e.type === 'campaignClear').length, 1);
    assert.equal(setPaused(campaign, true), false);
    const before = structuredClone(campaign);
    for (let i = 0; i < 100; i++) step(campaign, {fire: true, right: true});
    assert.deepEqual(campaign, before);
    assert.equal(restartGame(campaign).runMode, mode);
    assert.equal(restartGame(campaign, 3, 'endless').runMode, 'endless');
  }
  assert.equal(createGame().runMode, 'endless', 'engine and existing balance tooling retain survival behavior');
  for (const bad of [null, '__proto__', {}, NaN]) assert.equal(runMode(bad), 'endless');
});

test('endless keeps bounded collections through 150 clears and safe high scores', () => {
  const s = startGame(createGame({seed: 7, runMode: 'endless'}));
  for (let wave = 1; wave <= 150; wave++) {
    assert.equal(s.wave, wave); assert.ok(s.enemies.length <= 18);
    s.enemies.length = s.shots.length = 0; step(s);
    assert.equal(s.phase, 'intermission');
    for (let i = 0; i < Math.ceil(CONFIG.intermission / DT) + 1; i++) step(s);
    assert.ok(s.shots.length <= 8 && s.bullets.length <= 4 && s.reports.length <= 20);
    assert.ok(s.waveRecords.length <= 18 && s.events.length <= CONFIG.maxEvents);
    drainEvents(s);
  }
  s.score = Number.MAX_SAFE_INTEGER; s.enemies.length = s.shots.length = 0; step(s);
  assert.equal(s.score, Number.MAX_SAFE_INTEGER);
});

test('six bounded mode score keys preserve legacy and separate control and survival records', () => {
  const values = new Map([[STORAGE_KEY, JSON.stringify({v: 1, best: 200, wave: 3})]]);
  const store = {getItem: k => values.get(k), setItem: (k,v) => values.set(k,v)};
  let n = 0;
  for (const mode of Object.keys(RUN_MODES)) for (const evolve of [false, true]) {
    saveModeBest(++n * 100, n, mode, evolve, store);
    assert.deepEqual(loadModeBest(mode, evolve, store), {v: 2, best: n * 100, wave: n});
  }
  assert.equal(values.size, 7); assert.equal(loadBest(store).best, 200);
  saveModeBest(Number.MAX_SAFE_INTEGER, 1000, 'endless', true, store);
  assert.equal(loadModeBest('endless', true, store).wave, 1000);
  saveModeBest(Infinity, -1, 'endless', true, store);
  assert.equal(loadModeBest('endless', true, store).best, Number.MAX_SAFE_INTEGER);
  const key = modeStorageKey('campaign', true);
  for (const raw of ['x'.repeat(97), '{', '{"v":2,"best":1,"wave":1,"extra":0}']) {
    values.set(key, raw); assert.equal(loadModeBest('campaign', true, store).best, 0);
  }
  const denied = {getItem() {throw Error('Denied');}, setItem() {throw Error('Denied');}};
  assert.equal(saveModeBest(12, 1, 'campaign', true, denied).best, 12);
});
