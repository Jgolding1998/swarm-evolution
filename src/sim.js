// Deterministic game simulation. No DOM, no clocks, no Math.random: given a
// seed and the same per-step inputs it always produces the same game.

import { createRng, rand, range, gauss } from './rng.js';
import { phenotype, waveBudget, geneSum } from './genome.js';
import { emptyRecord, fitness, breed, founders, NEAR_RADIUS } from './evolution.js';

export const DT = 1 / 60;
export const WORLD = { w: 640, h: 720 };
export const PLAYER_Y = WORLD.h - 70;
export const DEFENSE_Y = WORLD.h - 26;

export const CONFIG = {
  lives: 3,
  maxLives: 5,
  shieldMax: 4,
  extraLifeEvery: 4,
  playerSpeed: 340,
  playerRadius: 15,
  fireCooldown: 0.16,
  maxPlayerBullets: 4,
  bulletSpeed: 620,
  invuln: 2.0,
  shotSpeed: 220,
  shotRadius: 4,
  intermission: 3.4,
  maxEvents: 256,
};

// Swarm size grows slowly so the visible trait budget, not a hidden headcount
// ramp, is the main difficulty driver.
export function waveSize(wave) {
  return Math.min(18, 9 + wave);
}

export function shotCap(wave) {
  return Math.min(8, 2 + wave);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createGame({ seed = 1, evolve = true } = {}) {
  const rng = createRng(seed);
  const ids = { nextId: 1, nextClade: 0 };
  const state = {
    seed: seed >>> 0,
    evolve: !!evolve,
    rng,
    ids,
    tick: 0,
    time: 0,
    phase: 'ready', // ready | playing | intermission | gameover
    paused: false,
    score: 0,
    lives: CONFIG.lives,
    shield: CONFIG.shieldMax,
    wave: 0,
    intermission: 0,
    player: { x: WORLD.w / 2, y: PLAYER_Y, px: WORLD.w / 2, vx: 0, cooldown: 0, invuln: 0 },
    bullets: [],
    shots: [],
    enemies: [],
    nextBullet: 1,
    population: founders(rng, waveSize(1), 1, ids),
    waveRecords: [],
    reports: [],
    lastReport: null,
    events: [],
    stats: { kills: 0, escapes: 0, hitsTaken: 0, shotsFired: 0 },
  };
  return state;
}

export function startGame(state) {
  if (state.phase !== 'ready') return state;
  state.phase = 'playing';
  spawnWave(state);
  return state;
}

export function restartGame(state, seed = state.seed) {
  return startGame(createGame({ seed, evolve: state.evolve }));
}

export function setPaused(state, paused) {
  if (state.phase === 'playing' || state.phase === 'intermission') state.paused = !!paused;
  else state.paused = false;
  return state.paused;
}

export function togglePause(state) {
  return setPaused(state, !state.paused);
}

function emit(state, ev) {
  if (state.events.length < CONFIG.maxEvents) state.events.push(ev);
}

export function drainEvents(state) {
  const ev = state.events;
  state.events = [];
  return ev;
}

export function makeEnemy(state, genome, x, delay = 0) {
  const ph = phenotype(genome.genes);
  const rec = emptyRecord();
  state.waveRecords.push({ genome, rec });
  return {
    id: genome.id,
    genome,
    ph,
    rec,
    x,
    y: -30,
    px: x,
    py: -30,
    baseX: x,
    hp: ph.hp,
    age: 0,
    delay,
    phase: rand(state.rng) * Math.PI * 2,
    dashT: 0,
    dashDir: 1,
    feintT: range(state.rng, 1.0, 3.0),
    fireT: range(state.rng, 1.2, 3.2),
    evadeT: 0,
    evadeV: 0,
    evadeBullet: 0,
    lastSeen: 0,
    dodgeCd: 0,
    flash: 0,
  };
}

export function spawnWave(state) {
  state.wave += 1;
  state.waveRecords = [];
  const pop = state.population;
  const cols = Math.min(pop.length, 8);
  const margin = 70;
  for (let i = 0; i < pop.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const t = cols === 1 ? 0.5 : col / (cols - 1);
    const x = margin + (WORLD.w - 2 * margin) * t + (row % 2 ? 18 : -18);
    state.enemies.push(makeEnemy(state, pop[i], clamp(x, 30, WORLD.w - 30), row * 1.5 + col * 0.09));
  }
  emit(state, { type: 'waveStart', wave: state.wave });
}

function enemyValue(e) {
  return 50 + Math.round(30 * geneSum(e.genome.genes)) + 25 * (e.ph.hp - 1);
}

function loseLife(state) {
  const p = state.player;
  state.lives -= 1;
  state.stats.hitsTaken += 1;
  p.invuln = CONFIG.invuln;
  state.shots.length = 0; // a clean breather after every hit
  emit(state, { type: 'playerHit', x: p.x, y: p.y });
  if (state.lives <= 0) {
    state.lives = 0;
    state.phase = 'gameover';
    emit(state, { type: 'gameover', score: state.score, wave: state.wave });
  }
}

function canBeHit(state) {
  return state.player.invuln <= 0 && state.phase !== 'gameover';
}

function updatePlayer(state, input, dt) {
  const p = state.player;
  p.px = p.x;
  let vx = 0;
  if (input.pointerX != null && Number.isFinite(input.pointerX)) {
    vx = clamp((input.pointerX - p.x) / dt, -CONFIG.playerSpeed, CONFIG.playerSpeed);
  } else {
    vx = ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * CONFIG.playerSpeed;
  }
  const r = CONFIG.playerRadius + 4;
  p.x = clamp(p.x + vx * dt, r, WORLD.w - r);
  p.vx = (p.x - p.px) / dt; // aim follows actual motion, including boundary stops
  p.cooldown = Math.max(0, p.cooldown - dt);
  p.invuln = Math.max(0, p.invuln - dt);
  if (input.fire && p.cooldown <= 0 && state.bullets.length < CONFIG.maxPlayerBullets) {
    state.bullets.push({ id: state.nextBullet++, x: p.x, y: p.y - 18, py: p.y - 18 });
    p.cooldown = CONFIG.fireCooldown;
    state.stats.shotsFired += 1;
    emit(state, { type: 'shot', x: p.x, y: p.y - 18 });
  }
}

function fireShot(state, e) {
  const p = state.player;
  const dy = p.y - e.y;
  const t = dy / CONFIG.shotSpeed;
  const tx = p.x + p.vx * t * e.ph.aim;
  let ang = Math.atan2(tx - e.x, dy) * (0.25 + 0.75 * e.ph.aim);
  ang += gauss(state.rng) * (1 - e.ph.aim) * 0.16;
  ang = clamp(ang, -0.8, 0.8);
  state.shots.push({ x: e.x, y: e.y + e.ph.radius, px: e.x, py: e.y, vx: Math.sin(ang) * CONFIG.shotSpeed, vy: Math.cos(ang) * CONFIG.shotSpeed, owner: e.id, rec: e.rec });
  emit(state, { type: 'enemyShot', x: e.x, y: e.y });
}

function updateEnemy(state, e, dt) {
  if (e.delay > 0) {
    e.delay -= dt;
    return;
  }
  const ph = e.ph;
  const p = state.player;
  const rec = e.rec;
  e.px = e.x;
  e.py = e.y;
  e.age += dt;
  rec.aliveTime += dt;
  e.flash = Math.max(0, e.flash - dt);

  if (ph.seek > 0) {
    const d = p.x - e.baseX;
    e.baseX += clamp(d, -ph.seek * dt, ph.seek * dt);
  }

  // Feint: a short dash one way, then a faster cut back the other way.
  if (ph.feintRate > 0.04) {
    e.feintT -= dt;
    if (e.feintT <= 0 && e.dashT <= 0) {
      e.dashT = 0.5;
      e.dashDir = rand(state.rng) < 0.5 ? -1 : 1;
      e.feintT = range(state.rng, 1.4, 3.0) / (0.35 + ph.feintRate);
    }
  }
  if (e.dashT > 0) {
    const v = (e.dashT > 0.32 ? 1 : -1.6) * 170 * e.dashDir;
    e.baseX += v * dt;
    e.dashT -= dt;
  }

  // Dodge: each incoming bullet is judged once, with a gene-scaled chance.
  e.dodgeCd -= dt;
  if (ph.dodge > 0.02 && e.evadeT <= 0 && e.dodgeCd <= 0) {
    for (const b of state.bullets) {
      if (b.id <= e.lastSeen) continue;
      const dy = e.y - b.y;
      if (dy < 0 && dy > -(70 + 110 * ph.dodge) && Math.abs(b.x - e.x) < ph.radius + 8) {
        e.lastSeen = b.id;
        if (rand(state.rng) < 0.2 + 0.65 * ph.dodge) {
          let dir = e.x >= b.x ? 1 : -1;
          if (e.x < 60) dir = 1;
          else if (e.x > WORLD.w - 60) dir = -1;
          e.evadeT = 0.28;
          e.evadeV = dir * (110 + 190 * ph.dodge);
          e.evadeBullet = b.id;
        }
        break;
      }
    }
  }
  if (e.evadeT > 0) {
    e.baseX += e.evadeV * dt;
    e.evadeT -= dt;
    if (e.evadeT <= 0) e.dodgeCd = 0.7 - 0.4 * ph.dodge;
  }

  const bound = ph.radius + 4;
  e.baseX = clamp(e.baseX, bound, WORLD.w - bound);
  e.y += ph.descend * dt;
  e.x = clamp(e.baseX + ph.weaveAmp * Math.sin(e.phase + e.age * ph.weaveFreq * Math.PI * 2), bound, WORLD.w - bound);

  if (e.evadeBullet) {
    const b = state.bullets.find((bb) => bb.id === e.evadeBullet);
    if (!b) e.evadeBullet = 0;
    else if (b.y < e.y - ph.radius) {
      rec.dodges += 1;
      e.evadeBullet = 0;
    }
  }

  e.fireT -= dt;
  if (e.fireT <= 0) {
    e.fireT = range(state.rng, 0.75, 1.25) / ph.fireRate;
    if (e.y > 10 && e.y < PLAYER_Y - 150 && state.shots.length < shotCap(state.wave)) fireShot(state, e);
  }

  const dx = p.x - e.x;
  const dyp = p.y - e.y;
  if (dx * dx + dyp * dyp < NEAR_RADIUS * NEAR_RADIUS) rec.nearTime += dt;
  rec.progress = Math.max(rec.progress, clamp(e.y / PLAYER_Y, 0, 1));
}

function removeEnemy(state, i) {
  state.enemies.splice(i, 1);
}

function enemyPhase(state, dt) {
  const p = state.player;
  for (let i = state.enemies.length - 1; i >= 0; i--) {
    if (state.phase === 'gameover') return;
    const e = state.enemies[i];
    updateEnemy(state, e, dt);
    if (e.delay > 0) continue;
    if (e.y > DEFENSE_Y) {
      e.rec.escaped = true;
      e.rec.progress = 1;
      state.stats.escapes += 1;
      state.shield -= 1;
      emit(state, { type: 'escape', x: e.x, y: DEFENSE_Y, clade: e.genome.clade });
      removeEnemy(state, i);
      if (state.shield <= 0 && state.phase !== 'gameover') {
        state.shield = CONFIG.shieldMax;
        loseLife(state);
      }
      continue;
    }
    if (canBeHit(state)) {
      const rr = e.ph.radius + CONFIG.playerRadius - 4;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy < rr * rr) {
        e.rec.rams += 1;
        e.rec.killed = true;
        state.stats.kills += 1;
        emit(state, { type: 'kill', x: e.x, y: e.y, clade: e.genome.clade, ram: true });
        removeEnemy(state, i);
        loseLife(state);
      }
    }
  }
}

function bulletPhase(state, dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.py = b.y;
    b.y -= CONFIG.bulletSpeed * dt;
    if (b.y < -20) {
      state.bullets.splice(i, 1);
      continue;
    }
    for (let j = state.enemies.length - 1; j >= 0; j--) {
      const e = state.enemies[j];
      if (e.delay > 0) continue;
      const r = e.ph.radius + 3;
      const dx = b.x - e.x;
      // Check the swept segment so fast bullets cannot tunnel.
      const top = Math.min(b.y, b.py) - r;
      const bottom = Math.max(b.y, b.py) + r;
      if (Math.abs(dx) < r && e.y > top && e.y < bottom) {
        state.bullets.splice(i, 1);
        if (e.evadeBullet === b.id) e.evadeBullet = 0;
        e.hp -= 1;
        e.flash = 0.12;
        if (e.hp > 0) {
          e.rec.absorbed += 1;
          emit(state, { type: 'absorb', x: e.x, y: e.y });
        } else {
          e.rec.killed = true;
          state.stats.kills += 1;
          state.score += enemyValue(e);
          emit(state, { type: 'kill', x: e.x, y: e.y, clade: e.genome.clade });
          removeEnemy(state, j);
        }
        break;
      }
    }
  }
}

function shotPhase(state, dt) {
  const p = state.player;
  for (let i = state.shots.length - 1; i >= 0; i--) {
    const s = state.shots[i];
    s.px = s.x;
    s.py = s.y;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.y > WORLD.h + 10 || s.x < -10 || s.x > WORLD.w + 10) {
      state.shots.splice(i, 1);
      continue;
    }
    if (canBeHit(state)) {
      const rr = CONFIG.playerRadius - 3 + CONFIG.shotRadius;
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      if (dx * dx + dy * dy < rr * rr) {
        s.rec.hits += 1;
        state.shots.splice(i, 1);
        loseLife(state); // also clears the remaining shots
        return;
      }
    }
  }
}

function finishWave(state) {
  const scored = state.waveRecords.map(({ genome, rec }) => ({ genome, record: rec, fitness: fitness(rec) }));
  const next = state.wave + 1;
  const { genomes, report } = breed(state.rng, scored, { count: waveSize(next), wave: next, ids: state.ids, evolve: state.evolve });
  state.population = genomes;
  state.lastReport = report;
  state.reports.push(report);
  if (state.reports.length > 20) state.reports.shift();
  const clean = report.outcome.escaped === 0;
  state.score += 100 * state.wave * (clean ? 2 : 1);
  state.shield = Math.min(CONFIG.shieldMax, state.shield + 1);
  if (state.wave % CONFIG.extraLifeEvery === 0 && state.lives < CONFIG.maxLives) {
    state.lives += 1;
    emit(state, { type: 'extraLife' });
  }
  state.phase = 'intermission';
  state.intermission = CONFIG.intermission;
  emit(state, { type: 'waveClear', wave: state.wave, clean });
}

const IDLE = Object.freeze({ left: false, right: false, fire: false, pointerX: null });

export function step(state, input = IDLE) {
  if (state.paused || state.phase === 'ready' || state.phase === 'gameover') return state;
  const dt = DT;
  const inp = input || IDLE;
  state.tick += 1;
  state.time += dt;
  updatePlayer(state, inp, dt);
  bulletPhase(state, dt);
  if (state.phase === 'intermission') {
    state.intermission -= dt;
    if (state.intermission <= 0) {
      state.phase = 'playing';
      spawnWave(state);
    }
  }
  enemyPhase(state, dt);
  if (state.phase !== 'gameover') shotPhase(state, dt);
  if (state.phase === 'playing' && state.enemies.length === 0 && state.shots.length === 0) finishWave(state);
  return state;
}

// Compact, comparable view of everything that matters for determinism.
export function snapshot(state) {
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return JSON.stringify({
    tick: state.tick,
    rng: state.rng.s,
    phase: state.phase,
    score: state.score,
    lives: state.lives,
    shield: state.shield,
    wave: state.wave,
    player: [r(state.player.x), r(state.player.invuln)],
    enemies: state.enemies.map((e) => [e.id, r(e.x), r(e.y), e.hp]),
    bullets: state.bullets.map((b) => [b.id, r(b.x), r(b.y)]),
    shots: state.shots.map((s) => [s.owner, r(s.x), r(s.y)]),
    population: state.population.map((g) => [g.id, g.clade, g.parents, ...Object.values(g.genes).map(r)]),
  });
}

export { waveBudget };
