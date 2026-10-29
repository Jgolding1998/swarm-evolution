// Heritable traits. Every gene is a number in [0, 1]. A per-wave budget caps
// the sum of genes, so evolution has to trade traits against each other
// instead of maxing everything.

import { rand, gauss } from './rng.js';

export const GENES = ['speed', 'weave', 'armor', 'feint', 'aim', 'fire', 'dodge', 'seek'];

export const GENE_INFO = {
  speed: { label: 'Thrust', hint: 'descends faster' },
  weave: { label: 'Weave', hint: 'wider side-to-side swing' },
  armor: { label: 'Armor', hint: 'extra plating, but a bigger hull' },
  feint: { label: 'Feint', hint: 'sudden fake-out dashes' },
  aim: { label: 'Aim', hint: 'leads your ship when firing' },
  fire: { label: 'Fire rate', hint: 'shoots more often' },
  dodge: { label: 'Dodge', hint: 'sidesteps incoming shots' },
  seek: { label: 'Seek', hint: 'drifts toward your lane' },
};

export const BUDGET_BASE = 1.6;
export const BUDGET_STEP = 0.3;
export const BUDGET_MAX = 4.4; // of a possible 8.0

export function waveBudget(wave) {
  const w = Math.max(1, Math.floor(wave));
  return Math.min(BUDGET_MAX, BUDGET_BASE + BUDGET_STEP * (w - 1));
}

export function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function geneSum(genes) {
  let s = 0;
  for (const g of GENES) s += genes[g];
  return s;
}

// Clamp every gene and scale the set down if it exceeds the budget.
export function normalizeGenes(genes, budget) {
  const out = {};
  for (const g of GENES) out[g] = clamp01(genes[g]);
  const sum = geneSum(out);
  if (sum > budget && sum > 0) {
    const k = budget / sum;
    for (const g of GENES) out[g] = out[g] * k;
  }
  return out;
}

export function randomGenes(rng, budget) {
  const raw = {};
  // Squaring skews founders toward a few strong traits rather than a flat mix.
  for (const g of GENES) raw[g] = rand(rng) ** 2;
  return fitToBudget(raw, budget);
}

// Rescale genes so they spend exactly the budget (each still in [0, 1]).
// Difficulty then comes from the visible budget, and evolution only decides
// how that budget is allocated.
export function fitToBudget(genes, budget) {
  const cap = Math.min(budget, GENES.length);
  const out = {};
  for (const g of GENES) out[g] = clamp01(genes[g]);
  for (let iter = 0; iter < 12; iter++) {
    const sum = geneSum(out);
    const need = cap - sum;
    if (Math.abs(need) < 1e-9) break;
    if (need < 0) {
      for (const g of GENES) out[g] *= cap / sum;
      break;
    }
    const free = GENES.filter((g) => out[g] < 1);
    const freeSum = free.reduce((a, g) => a + out[g], 0);
    for (const g of free) {
      out[g] = freeSum > 1e-9 ? out[g] * (1 + need / freeSum) : out[g] + need / free.length;
      if (out[g] > 1) out[g] = 1;
    }
  }
  return out;
}

// Uniform crossover: each gene comes whole from one parent.
export function crossover(rng, a, b) {
  const child = {};
  for (const g of GENES) child[g] = rand(rng) < 0.5 ? a[g] : b[g];
  return child;
}

export function mutate(rng, genes, sigma, budget) {
  const out = {};
  for (const g of GENES) {
    // Most genes get small drift; occasionally one jumps further.
    const scale = rand(rng) < 0.12 ? sigma * 2.5 : sigma;
    out[g] = genes[g] + gauss(rng) * scale;
  }
  return normalizeGenes(out, budget);
}

// Derived, bounded behaviour numbers used by the simulation.
export function phenotype(genes) {
  const g = normalizeGenes(genes, GENES.length);
  return {
    descend: 22 + 44 * g.speed, // units per second
    weaveAmp: 8 + 72 * g.weave,
    weaveFreq: 0.35 + 0.55 * g.weave,
    hp: 1 + Math.round(2 * g.armor),
    radius: 13 + 6 * g.armor,
    feintRate: g.feint, // 0 disables dashes
    aim: g.aim,
    fireRate: 0.06 + 0.42 * g.fire, // shots per second
    dodge: g.dodge,
    seek: 75 * g.seek, // lateral tracking speed
  };
}

export const NAME_PARTS = ['Vesper', 'Kestrel', 'Orrin', 'Sable', 'Thorne', 'Quill', 'Marrow', 'Lumen', 'Cinder', 'Halcyon', 'Rook', 'Nadir', 'Ember', 'Wren', 'Ixia', 'Tallis'];

export function cladeName(clade) {
  const i = Math.abs(Math.floor(clade));
  const base = NAME_PARTS[i % NAME_PARTS.length];
  const gen = Math.floor(i / NAME_PARTS.length);
  return gen > 0 ? `${base} ${gen + 1}` : base;
}

export function cladeHue(clade) {
  return (Math.abs(Math.floor(clade)) * 137.508 + 300) % 360;
}
