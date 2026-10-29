import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, rand } from '../src/rng.js';
import { GENES, waveBudget, randomGenes, mutate, crossover, fitToBudget, normalizeGenes, phenotype, geneSum, BUDGET_MAX } from '../src/genome.js';

test('rng is reproducible and in range', () => {
  const a = createRng(42), b = createRng(42), c = createRng(43);
  const xs = Array.from({ length: 1000 }, () => rand(a));
  const ys = Array.from({ length: 1000 }, () => rand(b));
  assert.deepEqual(xs, ys);
  assert.notDeepEqual(xs.slice(0, 5), [rand(c), rand(c), rand(c), rand(c), rand(c)]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});

test('wave budget grows then caps well below the trait maximum', () => {
  assert.equal(waveBudget(1), 1.6);
  assert.ok(waveBudget(5) > waveBudget(4));
  assert.equal(waveBudget(50), BUDGET_MAX);
  assert.ok(BUDGET_MAX < GENES.length * 0.6, 'no wave can max every trait');
  assert.equal(waveBudget(-3), waveBudget(1));
});

test('traits stay bounded through many mutations and crossovers', () => {
  const rng = createRng(7);
  let pop = Array.from({ length: 12 }, () => randomGenes(rng, 1.6));
  for (let gen = 1; gen <= 400; gen++) {
    const budget = waveBudget(gen);
    pop = pop.map(() => fitToBudget(mutate(rng, crossover(rng, pop[0], pop[(gen * 5) % pop.length]), 0.3, budget), budget));
    for (const g of pop) {
      for (const k of GENES) assert.ok(g[k] >= 0 && g[k] <= 1, `${k}=${g[k]}`);
      assert.ok(Math.abs(geneSum(g) - budget) < 1e-6, 'spends exactly the budget');
    }
  }
});

test('hostile or malformed genes are sanitised', () => {
  const g = normalizeGenes({ speed: NaN, weave: Infinity, armor: -5, feint: 99, aim: '1', fire: undefined, dodge: 0.5, seek: 1 }, 2);
  for (const k of GENES) assert.ok(Number.isFinite(g[k]) && g[k] >= 0 && g[k] <= 1);
  assert.ok(geneSum(g) <= 2 + 1e-9);
  const ph = phenotype({ speed: 50, armor: -1 });
  assert.ok(ph.descend <= 66 && ph.hp >= 1 && ph.hp <= 3);
});

test('crossover only inherits values from the two parents', () => {
  const rng = createRng(3);
  const a = Object.fromEntries(GENES.map((g) => [g, 0.1]));
  const b = Object.fromEntries(GENES.map((g) => [g, 0.9]));
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const c = crossover(rng, a, b);
    for (const g of GENES) {
      assert.ok(c[g] === 0.1 || c[g] === 0.9);
      seen.add(c[g]);
    }
  }
  assert.equal(seen.size, 2);
});

test('phenotype maps genes to bounded behaviour with trade-offs', () => {
  const lo = phenotype(Object.fromEntries(GENES.map((g) => [g, 0])));
  const hi = phenotype(Object.fromEntries(GENES.map((g) => [g, 1])));
  assert.ok(hi.descend > lo.descend && hi.descend <= 66);
  assert.equal(lo.hp, 1);
  assert.equal(hi.hp, 3);
  assert.ok(hi.radius > lo.radius, 'armor makes a bigger target');
  assert.ok(hi.fireRate <= 0.5);
});
