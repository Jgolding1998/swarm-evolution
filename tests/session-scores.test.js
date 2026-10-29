import test from 'node:test';
import assert from 'node:assert/strict';
import {createScoreSession, modeStorageKey} from '../src/storage.js';

test('blocked storage preserves best runs in memory across restarts and mode switches', () => {
  const denied = {getItem() {throw Error('Denied');}, setItem() {throw Error('Denied');}};
  const scores = createScoreSession(denied);
  scores.save(5000, 12, 'campaign', true);
  assert.deepEqual(scores.load('campaign', true), {v: 2, best: 5000, wave: 12});
  scores.save(1000, 2, 'campaign', true);
  assert.equal(scores.load('campaign', true).best, 5000);
  assert.equal(scores.load('endless', true).best, 0);
  assert.equal(scores.load('campaign', false).best, 0);
  const changed = scores.load('campaign', true); changed.best = 0;
  assert.equal(scores.load('campaign', true).best, 5000);
  assert.equal(createScoreSession(denied).load('campaign', true).best, 0);
});

test('recovered storage persists the session record and preserves higher external records', () => {
  const values = new Map(); let blocked = true;
  const store = {getItem: key => values.get(key), setItem(key, value) {if (blocked) throw Error('Quota'); values.set(key, value);}};
  const scores = createScoreSession(store);
  scores.save(5000, 12, 'campaign'); blocked = false;
  scores.save(100, 1, 'campaign');
  assert.equal(JSON.parse(values.get(modeStorageKey('campaign'))).best, 5000);
  values.set(modeStorageKey('campaign'), JSON.stringify({v: 2, best: 8000, wave: 20}));
  assert.equal(scores.load('campaign').best, 8000);
});
