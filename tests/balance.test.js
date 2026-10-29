import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, runGame } from '../tools/balance.js';
import { CONFIG } from '../src/sim.js';

test('pressure assay keeps equal complete cohorts while normal games retain normal lives', () => {
  for (const evolve of [false, true]) {
    const result = collect(evolve, 'casual', 8, 8, true);
    assert.equal(result.limited, 0);
    assert.equal(result.perWave.size, 8);
    for (let wave = 1; wave <= 8; wave += 1) assert.equal(result.perWave.get(wave).n, 8);
  }
  const normal = runGame(7919, true, 'casual', 8);
  assert.ok(normal.lives <= CONFIG.maxLives);
  assert.equal(CONFIG.lives, 3);
});

test('diagnostics retain all completed waves beyond the bounded in-game report history', () => {
  const reports = [];
  const state = runGame(7919, false, 'skilled', 30, {pressureAssay: true, onReport: (report) => reports.push(report)});
  assert.equal(reports.length, 30);
  assert.deepEqual(reports.map((report) => report.evaluatedWave), Array.from({length: 30}, (_, i) => i + 1));
  assert.equal(state.reports.length, 20);
});

test('a bounded diagnostic that reaches the simulation limit reports incomplete runs', () => {
  const result = collect(false, 'casual', 1, 100, true);
  assert.equal(result.limited, 1);
  assert.ok(result.perWave.size < 100);
});
