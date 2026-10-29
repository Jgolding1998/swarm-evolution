// Headless balance report: scripted pilots against evolving swarms and a
// random-allocation control at the same per-wave budget.
// Usage: node tools/balance.js [seeds=24] [maxWave=12]

import { createGame, startGame, step } from '../src/sim.js';
import { GENES } from '../src/genome.js';
import { createBot } from './bot.js';

const SEEDS = Math.max(1, Math.min(200, Number(process.argv[2]) || 24));
const MAX_WAVE = Math.max(2, Math.min(30, Number(process.argv[3]) || 12));
const MAX_TICKS = 60 * 60 * 20;

export function runGame(seed, evolve, profile, maxWave = MAX_WAVE) {
  const s = startGame(createGame({ seed, evolve }));
  const bot = createBot(profile);
  while (s.phase !== 'gameover' && s.wave <= maxWave && s.tick < MAX_TICKS) step(s, bot(s));
  return s;
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

function collect(evolve, profile) {
  const perWave = new Map();
  const reached = [];
  const genesByWave = new Map();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = runGame(seed * 7919, evolve, profile);
    reached.push(s.phase === 'gameover' ? s.wave : MAX_WAVE + 1);
    for (const r of s.reports) {
      const w = r.evaluatedWave;
      const o = r.outcome;
      const row = perWave.get(w) || { n: 0, pressure: 0, escaped: 0, hits: 0, fit: 0, killed: 0 };
      row.n++;
      row.pressure += (o.escaped + o.hits + o.rams) / o.count;
      row.escaped += o.escaped / o.count;
      row.hits += (o.hits + o.rams) / o.count;
      row.fit += o.fitnessMean;
      perWave.set(w, row);
      const gm = genesByWave.get(r.nextWave) || { n: 0, m: Object.fromEntries(GENES.map((g) => [g, 0])) };
      gm.n++;
      for (const g of GENES) gm.m[g] += r.nextMean[g] / r.budget;
      genesByWave.set(r.nextWave, gm);
    }
  }
  return { perWave, reached, genesByWave };
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`.padStart(6);
}

function report(profile) {
  const evo = collect(true, profile);
  const ctl = collect(false, profile);
  console.log(`\n== ${profile} pilot, ${SEEDS} seeds, cap wave ${MAX_WAVE} ==`);
  console.log(`median wave reached: evolving ${median(evo.reached)}, control ${median(ctl.reached)} (cap+1 = survived)`);
  console.log('wave | runs evo/ctl | pressure per drone evo vs ctl | breach evo vs ctl | mean fitness evo vs ctl');
  let sumE = 0, sumC = 0, k = 0;
  for (let w = 1; w <= MAX_WAVE; w++) {
    const e = evo.perWave.get(w);
    const c = ctl.perWave.get(w);
    if (!e || !c) continue;
    const pe = e.pressure / e.n, pc = c.pressure / c.n;
    if (w >= 2) { sumE += pe; sumC += pc; k++; }
    console.log(`${String(w).padStart(4)} | ${String(e.n).padStart(3)}/${String(c.n).padEnd(3)}      | ${pct(pe)} vs ${pct(pc)}            | ${pct(e.escaped / e.n)} vs ${pct(c.escaped / c.n)} | ${(e.fit / e.n).toFixed(1).padStart(6)} vs ${(c.fit / c.n).toFixed(1)}`);
  }
  if (k) console.log(`avg pressure waves 2+: evolving ${pct(sumE / k)} vs control ${pct(sumC / k)}`);
  const last = [...evo.genesByWave.keys()].filter((w) => evo.genesByWave.get(w).n >= Math.max(3, SEEDS / 4)).pop();
  if (last) {
    const g2 = evo.genesByWave.get(2), gl = evo.genesByWave.get(last);
    const share = (gm, g) => gm.m[g] / gm.n;
    console.log(`budget share by gene, wave 2 -> wave ${last} (evolving):`);
    console.log('  ' + GENES.map((g) => `${g} ${(share(g2, g) * 100).toFixed(0)}->${(share(gl, g) * 100).toFixed(0)}%`).join(', '));
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('balance.js')) {
  const t0 = Date.now();
  report('casual');
  report('skilled');
  console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
