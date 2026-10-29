// DOM side of the HUD and intel panel. All text goes through textContent.

import { GENES, GENE_INFO, cladeHue, cladeName, waveBudget } from './genome.js';
import { geneMeans, explainReport } from './evolution.js';
import { CONFIG } from './sim.js';

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setPips(node, on, max, label) {
  if (node.childElementCount !== max) {
    node.replaceChildren(...Array.from({ length: max }, () => el('span', 'pip')));
  }
  [...node.children].forEach((c, i) => c.classList.toggle('on', i < on));
  node.setAttribute('aria-label', label);
}

export function createUI() {
  const hud = { score: $('hud-score'), wave: $('hud-wave'), lives: $('hud-lives'), shield: $('hud-shield'), best: $('hud-best') };
  const geneRows = {};
  const list = $('gene-list');
  for (const g of GENES) {
    const row = el('li', 'gene');
    row.title = GENE_INFO[g].hint;
    const track = el('span', 'gene-track');
    const fill = el('span', 'gene-fill');
    fill.style.display = 'block';
    track.append(fill);
    const val = el('span', 'gene-val', '0');
    const delta = el('span', 'gene-delta', '');
    row.append(el('span', 'gene-label', GENE_INFO[g].label), track, val, delta);
    list.append(row);
    geneRows[g] = { fill, val, delta };
  }
  let last = {};
  let lastReport = undefined;
  let lastPopKey = '';

  function hudUpdate(state, best) {
    const vals = { score: state.score, wave: Math.max(1, state.wave), lives: state.lives, shield: state.shield, best };
    if (vals.score !== last.score) hud.score.textContent = vals.score.toLocaleString('en-US');
    if (vals.wave !== last.wave) hud.wave.textContent = String(vals.wave);
    if (vals.best !== last.best) hud.best.textContent = vals.best.toLocaleString('en-US');
    if (vals.lives !== last.lives) setPips(hud.lives, vals.lives, Math.max(CONFIG.maxLives, vals.lives), `${vals.lives} lives`);
    if (vals.shield !== last.shield) {
      setPips(hud.shield, vals.shield, CONFIG.shieldMax, `Defense line ${vals.shield} of ${CONFIG.shieldMax}`);
      hud.shield.classList.toggle('low', vals.shield <= 1);
    }
    last = vals;
  }

  function intelUpdate(state) {
    const report = state.lastReport;
    const popKey = `${state.population[0]?.id}:${state.population.length}`;
    if (report === lastReport && popKey === lastPopKey) return;
    lastReport = report;
    lastPopKey = popKey;

    // During a wave the population on screen is state.population's parent set;
    // the bred next wave is shown once the report exists.
    const shownWave = report ? report.nextWave : 1;
    const means = report ? report.nextMean : geneMeans(state.population);
    const budget = waveBudget(shownWave);
    $('intel-sub').textContent = state.phase === 'won' ? 'Campaign complete. Final selection result:' : state.evolve
      ? `Wave ${shownWave} gene pool: budget ${budget.toFixed(1)} of 8 trait points`
      : `Control mode: random traits, budget ${budget.toFixed(1)}`;
    for (const g of GENES) {
      const r = geneRows[g];
      r.fill.style.width = `${Math.round(means[g] * 100)}%`;
      r.val.textContent = `${Math.round(means[g] * 100)}`;
      const d = report && report.evolve ? report.selection[g] : 0;
      const n = Math.round(d * 100);
      r.delta.textContent = report ? (n > 0 ? `+${n}` : n < 0 ? `${n}` : '0') : '';
      r.delta.classList.toggle('up', n >= 2);
      r.delta.classList.toggle('down', n <= -2);
    }

    const lines = report
      ? explainReport(report).filter(text => state.phase !== 'won' || !text.startsWith('Next:'))
      : ['Wave 1 drones are random founders.', 'Each drone is scored on how close it got, how long it lived, whether it breached your line and what it hit.', 'The best scorers breed the next wave.'];
    $('report').replaceChildren(...lines.map((t) => el('li', null, t)));

    const fit = $('fitness');
    if (report && report.best) {
      const b = report.best.breakdown;
      const rows = [['Approach', b.approach], ['Survival', b.survival], ['Breach', b.escape], ['Effect', b.effect]];
      fit.replaceChildren(...rows.map(([k, v]) => {
        const li = el('li', null, `${k} `);
        li.append(el('b', null, String(Math.round(v))));
        return li;
      }));
    } else {
      fit.replaceChildren(el('li', 'muted', 'No data yet'));
    }

    const clades = report ? report.clades : state.population.map((g) => ({ clade: g.clade, name: cladeName(g.clade), count: 1 }));
    const total = clades.reduce((a, c) => a + c.count, 0) || 1;
    $('clades').replaceChildren(...clades.slice(0, 5).map((c) => {
      const li = el('li', 'clade');
      const chip = el('span', 'clade-chip');
      chip.style.background = `hsl(${cladeHue(c.clade)}, 75%, 55%)`;
      const bar = el('span', 'clade-bar');
      bar.style.width = `${Math.max(4, Math.round((c.count / total) * 90))}px`;
      bar.style.background = `hsl(${cladeHue(c.clade)}, 60%, 45%)`;
      li.append(chip, el('span', 'clade-name', c.name), bar, el('span', 'muted', String(c.count)));
      return li;
    }));
  }

  return { hudUpdate, intelUpdate, reset() { last = {}; lastReport = undefined; lastPopKey = ''; } };
}
