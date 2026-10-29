import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, startGame, restartGame, step, togglePause, setPaused, snapshot, drainEvents, makeEnemy, waveSize, CONFIG, WORLD, DEFENSE_Y, PLAYER_Y, DT } from '../src/sim.js';
import { fitness, FITNESS } from '../src/evolution.js';
import { GENES } from '../src/genome.js';
import { consumeFrame, MAX_STEPS } from '../src/loop.js';
import { createBot } from '../tools/bot.js';

const idle = { left: false, right: false, fire: false, pointerX: null };
const flat = (v = 0.2) => Object.fromEntries(GENES.map((g) => [g, v]));

// A started game with the formation removed, so tests can place drones.
function emptyArena(seed = 1) {
  const s = startGame(createGame({ seed }));
  s.enemies.length = 0;
  s.waveRecords.length = 0;
  return s;
}

function addDrone(s, genes, x, y) {
  const e = makeEnemy(s, { id: 9000 + s.enemies.length, clade: 0, gen: 1, parents: [], genes }, x, 0);
  e.y = y;
  e.fireT = 1e9;
  s.enemies.push(e);
  return e;
}

test('same seed and inputs replay identically; different seeds diverge', () => {
  const run = (seed) => {
    const s = startGame(createGame({ seed }));
    const bot = createBot('skilled');
    const marks = [];
    for (let i = 0; i < 4000 && s.phase !== 'gameover'; i++) {
      step(s, bot(s));
      if (i % 500 === 0) marks.push(snapshot(s));
    }
    marks.push(snapshot(s));
    return marks;
  };
  assert.deepEqual(run(1234), run(1234));
  assert.notDeepEqual(run(1234), run(4321));
});

test('a drone that crosses the defense line escapes, costs shield and earns escape fitness', () => {
  const s = emptyArena();
  const e = addDrone(s, { ...flat(0), speed: 1 }, 40, DEFENSE_Y - 5);
  addDrone(s, flat(0), 320, -200); // keeps the wave open
  s.player.x = WORLD.w - 40;
  const shield = s.shield;
  for (let i = 0; i < 30; i++) step(s, idle);
  assert.equal(e.rec.escaped, true);
  assert.equal(e.rec.progress, 1);
  assert.equal(s.shield, shield - 1);
  assert.equal(s.stats.escapes, 1);
  assert.ok(fitness(e.rec) >= FITNESS.escape + FITNESS.progress);
});

test('repeated breaches drain the shield and then a life', () => {
  const s = emptyArena();
  s.player.x = WORLD.w - 40;
  for (let k = 0; k < CONFIG.shieldMax; k++) addDrone(s, flat(0), 40 + k * 30, DEFENSE_Y - 0.1);
  addDrone(s, flat(0), 320, -200);
  step(s, idle);
  assert.equal(s.lives, CONFIG.lives - 1);
  assert.equal(s.shield, CONFIG.shieldMax);
});

test('drones near the player accumulate approach reward, distant ones do not', () => {
  const s = emptyArena();
  s.player.x = 320;
  const near = addDrone(s, flat(0), 320, PLAYER_Y - 140);
  const far = addDrone(s, flat(0), 60, 80);
  for (let i = 0; i < 60; i++) step(s, idle);
  assert.ok(near.rec.nearTime > 0.9, `near ${near.rec.nearTime}`);
  assert.equal(far.rec.nearTime, 0);
  assert.ok(fitness(near.rec) > fitness(far.rec));
});

test('player bullets damage armor first, then destroy and score', () => {
  const s = emptyArena();
  s.player.x = 320;
  const tank = addDrone(s, { ...flat(0), armor: 1 }, 320, 300);
  tank.ph.descend = 0;
  assert.equal(tank.hp, 3);
  let guard = 0;
  while (s.enemies.includes(tank) && guard++ < 600) step(s, { ...idle, fire: true });
  assert.ok(!s.enemies.includes(tank));
  assert.equal(tank.rec.absorbed, 2);
  assert.equal(tank.rec.killed, true);
  assert.ok(s.score > 0);
});

test('enemy shot hit costs a life, grants invulnerability and credits the shooter', () => {
  const s = emptyArena();
  const shooter = addDrone(s, flat(0), 100, 100);
  s.shots.push({ x: s.player.x, y: s.player.y - 20, px: 0, py: 0, vx: 0, vy: 220, owner: shooter.id, rec: shooter.rec });
  for (let i = 0; i < 10; i++) step(s, idle);
  assert.equal(s.lives, CONFIG.lives - 1);
  assert.ok(s.player.invuln > 0);
  assert.equal(shooter.rec.hits, 1);
  s.shots.push({ x: s.player.x, y: s.player.y - 10, px: 0, py: 0, vx: 0, vy: 220, owner: shooter.id, rec: shooter.rec });
  for (let i = 0; i < 10; i++) step(s, idle);
  assert.equal(s.lives, CONFIG.lives - 1, 'invulnerable right after a hit');
});

test('ramming the player costs a life and ends in game over at zero lives', () => {
  const s = emptyArena();
  s.lives = 1;
  addDrone(s, flat(0), s.player.x, s.player.y - 5);
  step(s, idle);
  assert.equal(s.lives, 0);
  assert.equal(s.phase, 'gameover');
  const ev = drainEvents(s).map((e) => e.type);
  assert.ok(ev.includes('gameover'));
  const before = snapshot(s);
  step(s, { ...idle, fire: true, right: true });
  assert.equal(snapshot(s), before, 'game over freezes the sim');
});

test('a terminal hit stops the remaining enemies in the same step', () => {
  const s = emptyArena();
  s.lives = 1;
  s.shield = 1;
  const pending = addDrone(s, flat(0), 40, DEFENSE_Y + 1);
  // Enemy iteration runs backwards, so the ram is processed first.
  addDrone(s, flat(0), s.player.x, s.player.y - 5);
  drainEvents(s);
  step(s, idle);
  assert.equal(s.phase, 'gameover');
  assert.equal(s.shield, 1);
  assert.equal(s.stats.escapes, 0);
  assert.equal(pending.rec.escaped, false);
  assert.ok(s.enemies.includes(pending));
  const types = drainEvents(s).map((ev) => ev.type);
  assert.equal(types.at(-1), 'gameover', 'no gameplay event follows the terminal event');
});

test('pause freezes the simulation and resume continues', () => {
  const s = startGame(createGame({ seed: 77 }));
  for (let i = 0; i < 200; i++) step(s, idle);
  assert.equal(togglePause(s), true);
  const frozen = snapshot(s);
  for (let i = 0; i < 300; i++) step(s, { ...idle, fire: true, left: true });
  assert.equal(snapshot(s), frozen);
  setPaused(s, false);
  step(s, idle);
  assert.notEqual(snapshot(s), frozen);
  const ready = createGame({ seed: 1 });
  assert.equal(setPaused(ready, true), false, 'cannot pause before starting');
});

test('restart resets score, lives, wave and replays the same seed', () => {
  const s = startGame(createGame({ seed: 99 }));
  const bot = createBot('casual');
  for (let i = 0; i < 3000 && s.phase !== 'gameover'; i++) step(s, bot(s));
  assert.ok(s.tick > 0);
  const r = restartGame(s);
  assert.equal(r.score, 0);
  assert.equal(r.lives, CONFIG.lives);
  assert.equal(r.wave, 1);
  assert.equal(r.phase, 'playing');
  assert.equal(snapshot(r), snapshot(startGame(createGame({ seed: 99 }))));
});

test('player motion stays bounded and aim receives the actual velocity at each edge', () => {
  const s = startGame(createGame({ seed: 41 }));
  const edge = CONFIG.playerRadius + 4;
  for (const [x, input] of [[edge, { left: true }], [WORLD.w - edge, { right: true }]]) {
    s.player.x = x;
    step(s, input);
    assert.equal(s.player.x, x);
    assert.equal(s.player.vx, 0, 'a ship stopped at the edge has no lead velocity');
  }
  s.player.x = WORLD.w - edge - 1;
  step(s, { right: true });
  assert.equal(s.player.x, WORLD.w - edge);
  assert.ok(Math.abs(s.player.vx - 1 / DT) < 1e-9, 'a partial move reports its actual displacement');
  for (const pointerX of [-Number.MAX_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity]) {
    const before = s.player.x;
    step(s, { pointerX, left: true });
    assert.ok(Number.isFinite(s.player.x) && Number.isFinite(s.player.vx));
    assert.ok(s.player.x >= edge && s.player.x <= WORLD.w - edge);
    assert.ok(Math.abs(s.player.x - before) <= CONFIG.playerSpeed * DT + 1e-9);
  }
});

test('intermission pause freezes every state field and restart clears the pause', () => {
  const s = startGame(createGame({ seed: 42, evolve: false }));
  s.enemies.length = 0;
  step(s, idle);
  assert.equal(s.phase, 'intermission');
  assert.equal(setPaused(s, true), true);
  const before = structuredClone(s);
  for (let i = 0; i < 20; i++) step(s, { fire: true, right: true });
  assert.deepEqual(s, before, 'includes countdown, records, RNG, cooldowns and queued events');
  const reset = restartGame(s);
  assert.equal(reset.paused, false);
  assert.equal(reset.evolve, false);
  assert.equal(reset.phase, 'playing');
  assert.equal(reset.tick, 0);
  assert.deepEqual(reset.reports, []);
});

test('clearing a wave breeds the next one from the scored drones', () => {
  const s = startGame(createGame({ seed: 5 }));
  const firstIds = new Set(s.enemies.map((e) => e.id));
  // Simulate a lucky volley: every drone reaches some depth, then dies.
  s.enemies.forEach((e, i) => { e.rec.progress = i / 10; e.rec.aliveTime = i; e.rec.killed = true; });
  s.enemies.length = 0;
  step(s, idle);
  assert.equal(s.phase, 'intermission');
  assert.ok(s.lastReport);
  assert.equal(s.lastReport.evaluatedWave, 1);
  assert.equal(s.population.length, waveSize(2));
  const bred = s.population.filter((g) => g.parents.length > 0);
  assert.ok(bred.length >= waveSize(2) - 2);
  for (const g of bred) for (const p of g.parents) assert.ok(firstIds.has(p));
  for (let i = 0; i < Math.ceil(CONFIG.intermission / DT) + 2; i++) step(s, idle);
  assert.equal(s.phase, 'playing');
  assert.equal(s.wave, 2);
});

test('fixed-step clock is bounded after stalls', () => {
  const r1 = consumeFrame(0, 1 / 60, DT);
  assert.equal(r1.steps, 1);
  const r2 = consumeFrame(0, 5, DT);
  assert.ok(r2.steps <= MAX_STEPS);
  assert.equal(r2.acc, 0);
  assert.equal(consumeFrame(0, NaN, DT).steps, 0);
  assert.equal(consumeFrame(0, -1, DT).steps, 0);
});

test('long bot runs keep every drone and trait inside bounds', () => {
  const s = startGame(createGame({ seed: 2024 }));
  const bot = createBot('skilled');
  for (let i = 0; i < 20000 && s.phase !== 'gameover'; i++) {
    step(s, bot(s));
    for (const e of s.enemies) {
      assert.ok(e.x >= 0 && e.x <= WORLD.w);
      assert.ok(e.hp >= 1 && e.hp <= 3);
      for (const g of GENES) assert.ok(e.genome.genes[g] >= 0 && e.genome.genes[g] <= 1);
    }
    assert.ok(s.shots.length <= 8 && s.bullets.length <= CONFIG.maxPlayerBullets);
    assert.ok(s.events.length <= CONFIG.maxEvents);
  }
  assert.ok(s.wave >= 3, `reached wave ${s.wave}`);
});

test('swarm size ramps gently and caps, so the visible budget drives difficulty', () => {
  for (let w = 1; w < 40; w++) assert.ok(waveSize(w + 1) - waveSize(w) <= 1);
  assert.equal(waveSize(1), 10);
  assert.equal(waveSize(100), 18);
});
