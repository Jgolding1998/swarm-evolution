// Fitness, selection and breeding. Pure functions over plain data so the
// whole pipeline is testable without a browser.

import { GENES, GENE_INFO, crossover, mutate, randomGenes, fitToBudget, waveBudget, cladeName, geneSum } from './genome.js';
import { randInt } from './rng.js';

export const FITNESS = {
  progress: 40, // reaching the player's row from the top
  near: 14, // per second spent within NEAR_RADIUS of the player
  nearCap: 6,
  survival: 2, // per second alive
  survivalCap: 25,
  escape: 120, // slipped past the defense line
  hit: 90, // a shot that cost the player a life
  ram: 60,
  dodge: 8, // a player shot sidestepped and left behind
  absorb: 6, // a hit soaked by armor
};

export const NEAR_RADIUS = 160;

export const EVO = {
  elites: 2,
  tournament: 3,
  sigma: 0.09,
  immigrantShare: 0.1,
};

export function emptyRecord() {
  return { progress: 0, nearTime: 0, aliveTime: 0, escaped: false, killed: false, hits: 0, rams: 0, dodges: 0, absorbed: 0 };
}

export function fitnessBreakdown(rec) {
  const progress = Math.max(0, Math.min(1, rec.progress || 0));
  return {
    approach: FITNESS.progress * progress + FITNESS.near * Math.min(rec.nearTime || 0, FITNESS.nearCap),
    survival: FITNESS.survival * Math.min(rec.aliveTime || 0, FITNESS.survivalCap),
    escape: rec.escaped ? FITNESS.escape : 0,
    effect: FITNESS.hit * (rec.hits || 0) + FITNESS.ram * (rec.rams || 0) + FITNESS.dodge * (rec.dodges || 0) + FITNESS.absorb * (rec.absorbed || 0),
  };
}

export function fitness(rec) {
  const b = fitnessBreakdown(rec);
  return b.approach + b.survival + b.escape + b.effect;
}

export function geneMeans(genomes) {
  const m = {};
  for (const g of GENES) m[g] = 0;
  if (!genomes.length) return m;
  for (const gn of genomes) for (const g of GENES) m[g] += gn.genes[g];
  for (const g of GENES) m[g] /= genomes.length;
  return m;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx < 1e-12 || syy < 1e-12) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

export function tournament(rng, scored, k = EVO.tournament) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = scored[randInt(rng, scored.length)];
    if (!best || c.fitness > best.fitness) best = c;
  }
  return best;
}

function summarize(scored) {
  const out = { count: scored.length, escaped: 0, killed: 0, hits: 0, rams: 0, dodges: 0, absorbed: 0, nearTime: 0, fitnessMean: 0, fitnessBest: 0 };
  for (const s of scored) {
    const r = s.record;
    if (r.escaped) out.escaped++;
    if (r.killed) out.killed++;
    out.hits += r.hits; out.rams += r.rams; out.dodges += r.dodges; out.absorbed += r.absorbed;
    out.nearTime += r.nearTime;
    out.fitnessMean += s.fitness;
    out.fitnessBest = Math.max(out.fitnessBest, s.fitness);
  }
  if (scored.length) out.fitnessMean /= scored.length;
  return out;
}

function cladeShares(genomes) {
  const counts = new Map();
  for (const g of genomes) counts.set(g.clade, (counts.get(g.clade) || 0) + 1);
  return [...counts.entries()]
    .map(([clade, count]) => ({ clade, name: cladeName(clade), count }))
    .sort((a, b) => b.count - a.count || a.clade - b.clade);
}

function newGenome(id, clade, gen, parents, genes) {
  return { id, clade, gen, parents, genes };
}

export function founders(rng, count, wave, ids) {
  const budget = waveBudget(wave);
  const genomes = [];
  for (let i = 0; i < count; i++) {
    genomes.push(newGenome(ids.nextId++, ids.nextClade++, 1, [], randomGenes(rng, budget)));
  }
  return genomes;
}

// Build the next wave from the scored previous wave.
// ids is mutated: { nextId, nextClade }.
export function breed(rng, scored, { count, wave, ids, evolve = true }) {
  const budget = waveBudget(wave);
  const genomes = [];
  const parentUse = [];
  let elites = 0, immigrants = 0;

  if (!evolve || scored.length === 0) {
    // Control mode: same budget and size, no inheritance.
    for (const g of founders(rng, count, wave, ids)) genomes.push(g);
    immigrants = count;
  } else {
    const ranked = [...scored].sort((a, b) => b.fitness - a.fitness || a.genome.id - b.genome.id);
    const eliteCount = Math.min(EVO.elites, ranked.length, count);
    for (let i = 0; i < eliteCount; i++) {
      const p = ranked[i].genome;
      genomes.push(newGenome(ids.nextId++, p.clade, p.gen + 1, [p.id], fitToBudget(p.genes, budget)));
      parentUse.push(ranked[i]);
      elites++;
    }
    const immigrantCount = Math.min(count - genomes.length, Math.max(1, Math.round(count * EVO.immigrantShare)));
    while (genomes.length < count - immigrantCount) {
      const a = tournament(rng, ranked);
      let b = tournament(rng, ranked);
      for (let tries = 0; tries < 3 && b === a && ranked.length > 1; tries++) b = tournament(rng, ranked);
      const lead = a.fitness >= b.fitness ? a : b;
      const child = mutate(rng, crossover(rng, a.genome.genes, b.genome.genes), EVO.sigma, budget);
      genomes.push(newGenome(ids.nextId++, lead.genome.clade, Math.max(a.genome.gen, b.genome.gen) + 1, [a.genome.id, b.genome.id], fitToBudget(child, budget)));
      parentUse.push(a, b);
    }
    for (const g of founders(rng, count - genomes.length, wave, ids)) {
      genomes.push(g);
      immigrants++;
    }
  }

  const report = buildReport(scored, parentUse, genomes, { wave, budget, elites, immigrants, evolve });
  return { genomes, report };
}

export function buildReport(scored, parentUse, genomes, { wave, budget, elites, immigrants, evolve }) {
  const prevMean = geneMeans(scored.map((s) => s.genome));
  const parentMean = geneMeans(parentUse.map((s) => s.genome));
  const nextMean = geneMeans(genomes);
  const fits = scored.map((s) => s.fitness);
  const selection = {};
  const drivers = {};
  for (const g of GENES) {
    selection[g] = parentUse.length ? parentMean[g] - prevMean[g] : 0;
    drivers[g] = pearson(scored.map((s) => s.genome.genes[g]), fits);
  }
  let best = null;
  for (const s of scored) if (!best || s.fitness > best.fitness) best = s;
  return {
    evaluatedWave: wave - 1,
    nextWave: wave,
    budget,
    evolve,
    size: genomes.length,
    elites,
    immigrants,
    outcome: summarize(scored),
    prevMean,
    nextMean,
    selection,
    drivers,
    best: best && {
      id: best.genome.id,
      clade: best.genome.clade,
      cladeName: cladeName(best.genome.clade),
      fitness: best.fitness,
      breakdown: fitnessBreakdown(best.record),
      genes: { ...best.genome.genes },
    },
    clades: cladeShares(genomes),
    budgetUsed: genomes.length ? geneSum(nextMean) : 0,
  };
}

const SOURCE_LABEL = { approach: 'closing in', survival: 'staying alive', escape: 'breaching the line', effect: 'hits, dodges and armor' };

function fmtDelta(v) {
  const n = Math.round(v * 100);
  return `${n >= 0 ? '+' : ''}${n}`;
}

// Short plain-text lines for the intel panel. Values are numbers and fixed
// labels only, and the UI renders them with textContent.
export function explainReport(r) {
  if (!r) return [];
  const lines = [];
  const o = r.outcome;
  lines.push(`Wave ${r.evaluatedWave}: ${o.killed} destroyed, ${o.escaped} breached, ${o.hits + o.rams} hit you, ${o.dodges} dodges.`);
  if (r.best) {
    const b = r.best.breakdown;
    const src = Object.keys(b).sort((x, y) => b[y] - b[x])[0];
    lines.push(`Fittest: ${r.best.cladeName} #${r.best.id}, ${Math.round(r.best.fitness)} pts, mostly from ${SOURCE_LABEL[src]}.`);
  }
  if (!r.evolve) {
    lines.push('Control mode: next wave is random at the same budget.');
  } else {
    const ranked = GENES.map((g) => ({ g, d: r.selection[g] })).sort((a, b) => b.d - a.d);
    const up = ranked.filter((x) => x.d > 0.015).slice(0, 2);
    const down = ranked.filter((x) => x.d < -0.015).slice(-1);
    if (up.length) {
      lines.push(`Selected for ${up.map((x) => `${GENE_INFO[x.g].label} ${fmtDelta(x.d)}`).join(', ')}${down.length ? `; against ${GENE_INFO[down[0].g].label} ${fmtDelta(down[0].d)}` : ''}.`);
    } else {
      lines.push('No clear winner trait; the swarm is still exploring.');
    }
  }
  const lead = r.clades[0];
  lines.push(`Next: ${r.size} drones, budget ${r.budget.toFixed(1)}/8, ${r.elites} elites, ${r.immigrants} newcomer${r.immigrants === 1 ? '' : 's'}. ${lead ? `${lead.name} leads with ${lead.count}.` : ''}`.trim());
  return lines;
}
