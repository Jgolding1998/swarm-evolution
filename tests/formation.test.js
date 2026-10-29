import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, spawnWave } from '../src/sim.js';
import { breed, emptyRecord, founders } from '../src/evolution.js';
import { geneSum, waveBudget } from '../src/genome.js';
import { rand } from '../src/rng.js';

function incoming(seed, evolve = true) {
  const state = createGame({ seed, evolve });
  const scored = state.population.map((genome, index) => ({
    genome, record: emptyRecord(), fitness: 100 - index,
  }));
  state.population = breed(state.rng, scored, {count: 11, wave: 2, ids: state.ids, evolve}).genomes;
  state.wave = 1;
  return state;
}

test('spawn slots vary elite and newcomer positions without changing inherited genomes', () => {
  const eliteSlots = new Set(), newcomerSlots = new Set();
  for (let seed = 1; seed <= 20; seed += 1) {
    const state = incoming(seed);
    const population = state.population;
    const before = JSON.stringify(population);
    spawnWave(state);
    assert.equal(state.population, population);
    assert.equal(JSON.stringify(population), before);
    assert.equal(new Set(state.enemies.map((enemy) => enemy.id)).size, population.length);
    for (const enemy of state.enemies) {
      assert.ok(population.includes(enemy.genome));
      assert.ok(Math.abs(geneSum(enemy.genome.genes) - waveBudget(2)) < 1e-8);
    }
    eliteSlots.add(state.enemies.findIndex((enemy) => enemy.genome === population[0]));
    newcomerSlots.add(state.enemies.findIndex((enemy) => enemy.genome === population.at(-1)));
  }
  assert.ok(eliteSlots.size >= 8, `Elite visited ${eliteSlots.size} slots`);
  assert.ok(newcomerSlots.size >= 8, `Newcomer visited ${newcomerSlots.size} slots`);
});

test('formation permutations match across control and evolution independently of breeding draws', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const evolved = incoming(seed), control = incoming(seed, false), replay = incoming(seed);
    for (let i = 0; i < seed * 3; i += 1) rand(control.rng);
    for (const state of [evolved, control, replay]) spawnWave(state);
    const slots = (state) => state.enemies.map((enemy) => state.population.indexOf(enemy.genome));
    assert.deepEqual(slots(evolved), slots(control));
    assert.deepEqual(slots(evolved), slots(replay));
    assert.deepEqual(evolved.enemies.map((e) => [e.x, e.delay]), control.enemies.map((e) => [e.x, e.delay]));
  }
});

test('one seeded run varies formation slots across waves after the swarm size caps', () => {
  const state = createGame({seed: 41});
  state.population = founders(state.rng, 18, 9, state.ids);
  const slots = new Set();
  for (let wave = 9; wave <= 20; wave += 1) {
    state.wave = wave - 1;
    state.enemies = [];
    spawnWave(state);
    slots.add(state.enemies.findIndex((enemy) => enemy.genome === state.population[0]));
  }
  assert.ok(slots.size > 1, 'A fixed-size swarm must not lock one lineage into one slot');
});
