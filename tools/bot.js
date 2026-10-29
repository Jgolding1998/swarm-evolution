// Scripted pilot used by tests and the balance report. It only reads what a
// player could see, reacts on a delay, and moves at normal ship speed.

import { WORLD, CONFIG } from '../src/sim.js';

export const BOT_PROFILES = {
  casual: { lag: 14, lookahead: 0.45, aimSlack: 26 },
  skilled: { lag: 6, lookahead: 0.8, aimSlack: 16 },
};

export function createBot(profile = 'casual') {
  const cfg = BOT_PROFILES[profile] || BOT_PROFILES.casual;
  let held = { left: false, right: false, fire: false, pointerX: null };
  let wait = 0;
  return function botInput(state) {
    if (wait > 0) {
      wait -= 1;
      return held;
    }
    wait = cfg.lag;
    held = decide(state, cfg);
    return held;
  };
}

// Closest approach between the ship moving at velocity v and any threat
// over the lookahead window.
function clearance(state, v, cfg) {
  const p = state.player;
  let worst = Infinity;
  const lag = cfg.lag / 60;
  for (let t = 0; t <= cfg.lookahead + lag; t += 1 / 30) {
    const x = Math.max(20, Math.min(WORLD.w - 20, p.x + v * t));
    for (const s of state.shots) {
      const dx = s.x + s.vx * t - x;
      const dy = s.y + s.vy * t - p.y;
      worst = Math.min(worst, Math.hypot(dx, dy) - CONFIG.shotRadius);
    }
    for (const e of state.enemies) {
      if (e.delay > 0) continue;
      const dx = e.x - x;
      const dy = e.y + e.ph.descend * t - p.y;
      worst = Math.min(worst, Math.hypot(dx, dy) - e.ph.radius);
    }
  }
  return worst;
}

function decide(state, cfg) {
  const p = state.player;
  let target = null;
  for (const e of state.enemies) {
    if (e.delay > 0 || e.y < 0) continue;
    if (!target || e.y > target.y) target = e;
  }
  const goal = target ? target.x : WORLD.w / 2;
  const want = Math.sign(goal - p.x) * CONFIG.playerSpeed;
  const safeGoal = clearance(state, want, cfg);
  if (safeGoal > CONFIG.playerRadius + 6) {
    return { left: false, right: false, fire: !!target && Math.abs(goal - p.x) < cfg.aimSlack, pointerX: goal };
  }
  let best = want, bestC = safeGoal;
  for (const v of [-CONFIG.playerSpeed, 0, CONFIG.playerSpeed]) {
    const c = clearance(state, v, cfg);
    if (c > bestC) { best = v; bestC = c; }
  }
  return { left: best < 0, right: best > 0, fire: true, pointerX: null };
}
