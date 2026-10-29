import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../src/rng.js';
import { GENES, fitToBudget, waveBudget } from '../src/genome.js';
import { emptyRecord, fitness, fitnessBreakdown, breed, explainReport, FITNESS, EVO } from '../src/evolution.js';

const rec = (over) => ({ ...emptyRecord(), ...over });

test('fitness rewards approach, survival, escape and effective behaviour', () => {
  const early = rec({ progress: 0.1, aliveTime: 3, killed: true });
  const deep = rec({ progress: 0.8, aliveTime: 3, killed: true });
  const near = rec({ progress: 0.8, aliveTime: 3, nearTime: 2, killed: true });
  const escaped = rec({ progress: 1, aliveTime: 12, escaped: true });
  const sniper = rec({ progress: 0.4, aliveTime: 8, hits: 1, killed: true });
  const dodger = rec({ progress: 0.4, aliveTime: 8, dodges: 3, absorbed: 1, killed: true });
  const plain = rec({ progress: 0.4, aliveTime: 8, killed: true });
  assert.ok(fitness(deep) > fitness(early));
  assert.ok(fitness(near) > fitness(deep));
  assert.ok(fitness(escaped) > fitness(near));
  assert.ok(fitness(sniper) - fitness(plain) === FITNESS.hit);
  assert.ok(fitness(dodger) > fitness(plain));
  assert.equal(fitnessBreakdown(escaped).escape, FITNESS.escape);
});

test('survival and near rewards are capped so stalling cannot dominate', () => {
  const staller = rec({ progress: 0.3, aliveTime: 1000, nearTime: 1000 });
  const escaper = rec({ progress: 1, aliveTime: 15, escaped: true });
  assert.ok(fitness(escaper) > fitness(staller));
});

function population(rng, n, budget, biasGene) {
  return Array.from({ length: n }, (_, i) => {
    const genes = fitToBudget(Object.fromEntries(GENES.map((g) => [g, 0.1 + 0.8 * ((i * 37 + g.length * 11) % 13) / 13])), budget);
    // Fitness depends on one gene only, like drones whose speed lets them escape.
    const r = rec({ progress: genes[biasGene], aliveTime: 5, escaped: genes[biasGene] > 0.35 });
    return { genome: { id: i + 1, clade: i % 4, gen: 1, parents: [], genes }, record: r, fitness: fitness(r) };
  });
}

test('selection shifts the next wave toward traits that earned fitness', () => {
  for (const gene of ['speed', 'dodge', 'armor']) {
    const rng = createRng(11);
    const scored = population(rng, 20, waveBudget(3), gene);
    const prevMean = scored.reduce((a, s) => a + s.genome.genes[gene], 0) / scored.length;
    const ids = { nextId: 100, nextClade: 10 };
    const { genomes, report } = breed(rng, scored, { count: 22, wave: 4, ids });
    const nextMean = genomes.reduce((a, g) => a + g.genes[gene], 0) / genomes.length;
    assert.ok(nextMean > prevMean, `${gene}: ${prevMean} -> ${nextMean}`);
    assert.ok(report.selection[gene] > 0.02, 'selection differential points at the trait');
    assert.ok(report.drivers[gene] > 0.5, 'trait correlates with fitness');
  }
});

test('offspring inherit from recorded parents, elites carry over, newcomers are new clades', () => {
  const rng = createRng(5);
  const scored = population(rng, 12, waveBudget(2), 'speed');
  const ids = { nextId: 500, nextClade: 50 };
  const { genomes, report } = breed(rng, scored, { count: 14, wave: 3, ids });
  assert.equal(genomes.length, 14);
  const prevIds = new Set(scored.map((s) => s.genome.id));
  const best = [...scored].sort((a, b) => b.fitness - a.fitness)[0];
  const elite = genomes[0];
  assert.deepEqual(elite.parents, [best.genome.id]);
  assert.equal(elite.clade, best.genome.clade);
  for (const g of GENES) assert.ok(Math.abs(elite.genes[g] - fitToBudget(best.genome.genes, waveBudget(3))[g]) < 1e-12);
  const children = genomes.slice(EVO.elites, genomes.length - report.immigrants);
  for (const c of children) {
    assert.equal(c.parents.length, 2);
    for (const p of c.parents) assert.ok(prevIds.has(p));
    assert.ok(c.gen >= 2);
  }
  const newcomers = genomes.slice(genomes.length - report.immigrants);
  assert.ok(newcomers.length >= 1);
  for (const n of newcomers) {
    assert.deepEqual(n.parents, []);
    assert.ok(n.clade >= 50);
  }
  assert.equal(new Set(genomes.map((g) => g.id)).size, genomes.length, 'unique ids');
});

test('control mode ignores fitness entirely', () => {
  const rng = createRng(9);
  const scored = population(rng, 12, waveBudget(2), 'speed');
  const { genomes, report } = breed(rng, scored, { count: 12, wave: 3, ids: { nextId: 1, nextClade: 1 }, evolve: false });
  assert.ok(genomes.every((g) => g.parents.length === 0));
  assert.equal(report.evolve, false);
});

test('report explains outcomes in short plain text', () => {
  const rng = createRng(2);
  const scored = population(rng, 12, waveBudget(2), 'speed');
  const { report } = breed(rng, scored, { count: 14, wave: 3, ids: { nextId: 1, nextClade: 1 } });
  const lines = explainReport(report);
  assert.ok(lines.length >= 3 && lines.length <= 5);
  assert.ok(lines.some((l) => l.includes('Thrust')), lines.join('\n'));
  for (const l of lines) {
    assert.ok(l.length < 140);
    assert.ok(!/[<>]/.test(l));
  }
});
