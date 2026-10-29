// Canvas renderer. Reads simulation state, never writes it. Cosmetic effects
// (particles, shake, stars) use their own generator so they cannot affect
// the deterministic game.

import { WORLD, DEFENSE_Y, CONFIG } from './sim.js';
import { cladeHue } from './genome.js';

const TAU = Math.PI * 2;

function lcg(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const fxRand = lcg(0xa5a5);
  const starRand = lcg(0x51a2);
  const stars = Array.from({ length: 140 }, () => ({
    x: starRand() * WORLD.w,
    y: starRand() * WORLD.h,
    z: 0.25 + starRand() * 0.75,
    tw: starRand() * TAU,
  }));
  const nebulae = Array.from({ length: 3 }, (_, i) => ({ x: starRand() * WORLD.w, y: starRand() * WORLD.h, r: 160 + starRand() * 200, hue: [262, 200, 320][i] }));
  let particles = [];
  let rings = [];
  let shake = 0;
  let banner = null;
  let scale = 1;
  let reduced = false;
  let clock = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    scale = w / WORLD.w;
  }

  function toWorldX(clientX) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return WORLD.w / 2;
    return ((clientX - rect.left) / rect.width) * WORLD.w;
  }

  function spark(x, y, hue, n, speed, life) {
    const count = reduced ? Math.ceil(n / 3) : n;
    for (let i = 0; i < count && particles.length < 500; i++) {
      const a = fxRand() * TAU;
      const v = speed * (0.3 + fxRand() * 0.7);
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, hue, size: 1 + fxRand() * 2.2 });
    }
  }

  function consume(events) {
    for (const ev of events) {
      switch (ev.type) {
        case 'kill':
          spark(ev.x, ev.y, cladeHue(ev.clade), 26, 180, 0.7);
          rings.push({ x: ev.x, y: ev.y, r: 4, life: 0.4, hue: cladeHue(ev.clade) });
          shake = Math.max(shake, 3);
          break;
        case 'absorb':
          spark(ev.x, ev.y, 50, 8, 120, 0.3);
          break;
        case 'escape':
          spark(ev.x, ev.y, 0, 30, 220, 0.8);
          rings.push({ x: ev.x, y: ev.y, r: 8, life: 0.7, hue: 0 });
          shake = Math.max(shake, 7);
          break;
        case 'playerHit':
          spark(ev.x, ev.y, 190, 40, 260, 0.9);
          shake = Math.max(shake, 10);
          break;
        case 'waveStart':
          banner = { text: `Wave ${ev.wave}`, sub: 'The swarm adapts to how you play', t: 2.2 };
          break;
        case 'waveClear':
          banner = { text: ev.clean ? 'Wave held: double bonus' : 'Wave cleared', sub: 'Breeding the survivors', t: 2.4 };
          break;
        default:
          break;
      }
    }
  }

  function reset() {
    particles = [];
    rings = [];
    shake = 0;
    banner = null;
  }

  function background(t) {
    const g = ctx.createLinearGradient(0, 0, 0, WORLD.h);
    g.addColorStop(0, '#05060f');
    g.addColorStop(1, '#0b0820');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);
    for (const n of nebulae) {
      const rg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
      rg.addColorStop(0, `hsla(${n.hue}, 70%, 35%, 0.16)`);
      rg.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      ctx.fillStyle = rg;
      ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
    }
    for (const s of stars) {
      const y = reduced ? s.y : (s.y + t * 18 * s.z) % WORLD.h;
      const a = reduced ? 0.6 * s.z : 0.35 + 0.45 * s.z * (0.6 + 0.4 * Math.sin(s.tw + t * 2));
      ctx.fillStyle = `rgba(200, 220, 255, ${a.toFixed(3)})`;
      ctx.fillRect(s.x, y, s.z * 1.8, s.z * 1.8);
    }
  }

  function defenseLine(state) {
    const ratio = state.shield / CONFIG.shieldMax;
    const hue = 120 * ratio;
    ctx.save();
    ctx.strokeStyle = `hsla(${hue}, 90%, 60%, 0.75)`;
    ctx.lineWidth = 2;
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = reduced ? 0 : -clock * 20;
    ctx.beginPath();
    ctx.moveTo(0, DEFENSE_Y);
    ctx.lineTo(WORLD.w, DEFENSE_Y);
    ctx.stroke();
    ctx.setLineDash([]);
    const g = ctx.createLinearGradient(0, DEFENSE_Y, 0, WORLD.h);
    g.addColorStop(0, `hsla(${hue}, 90%, 50%, 0.18)`);
    g.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, DEFENSE_Y, WORLD.w, WORLD.h - DEFENSE_Y);
    ctx.fillStyle = `hsla(${hue}, 90%, 72%, 0.9)`;
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`DEFENSE LINE ${state.shield}/${CONFIG.shieldMax}`, WORLD.w - 10, DEFENSE_Y + 16);
    ctx.restore();
  }

  function drone(e, x, y) {
    const g = e.genome.genes;
    const r = e.ph.radius;
    const hue = cladeHue(e.genome.clade);
    ctx.save();
    ctx.translate(x, y);
    if (e.dashT > 0 && !reduced) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(-e.dashDir * 14, -4, r * 0.9, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Thrusters point up because drones fly down; flame length shows Thrust.
    const flame = 5 + 20 * g.speed;
    const flick = reduced ? 1 : 0.8 + 0.2 * Math.sin(clock * 40 + e.id);
    const fg = ctx.createLinearGradient(0, -r, 0, -r - flame);
    fg.addColorStop(0, `hsla(${(hue + 40) % 360}, 100%, 70%, 0.9)`);
    fg.addColorStop(1, 'hsla(30, 100%, 60%, 0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-r * 0.35, -r * 0.7);
    ctx.lineTo(0, -r - flame * flick);
    ctx.lineTo(r * 0.35, -r * 0.7);
    ctx.fill();
    // Wings scale with Weave, fins with Dodge.
    const span = r * (0.8 + 1.2 * g.weave);
    ctx.fillStyle = `hsl(${hue}, 55%, 32%)`;
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.2);
    ctx.lineTo(-r * 0.5 - span, -r * 0.6);
    ctx.lineTo(-r * 0.4, r * 0.5);
    ctx.moveTo(r * 0.5, -r * 0.2);
    ctx.lineTo(r * 0.5 + span, -r * 0.6);
    ctx.lineTo(r * 0.4, r * 0.5);
    ctx.fill();
    if (g.dodge > 0.15) {
      ctx.strokeStyle = `hsla(${hue}, 90%, 75%, ${0.3 + 0.6 * g.dodge})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-r - 2, r * 0.1);
      ctx.lineTo(-r - 6 - 6 * g.dodge, r * 0.6);
      ctx.moveTo(r + 2, r * 0.1);
      ctx.lineTo(r + 6 + 6 * g.dodge, r * 0.6);
      ctx.stroke();
    }
    // Hull.
    ctx.fillStyle = e.flash > 0 ? '#ffffff' : `hsl(${hue}, 75%, 52%)`;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6;
      const k = i === 1 || i === 2 ? 1.15 : 0.92;
      ctx.lineTo(Math.cos(a) * r * k, Math.sin(a) * r * k);
    }
    ctx.closePath();
    ctx.fill();
    // Armor plates: one ring per hit point, dim once lost.
    for (let i = 0; i < e.ph.hp; i++) {
      ctx.strokeStyle = i < e.hp ? 'rgba(255, 236, 170, 0.9)' : 'rgba(255, 236, 170, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r + 3 + i * 3.2, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
    // Cannons show Fire rate.
    ctx.fillStyle = `hsl(${hue}, 40%, 22%)`;
    const barrel = 3 + 8 * g.fire;
    ctx.fillRect(-r * 0.45 - 1.5, r * 0.6, 3, barrel);
    ctx.fillRect(r * 0.45 - 1.5, r * 0.6, 3, barrel);
    // Sensor eye brightens with Aim.
    ctx.fillStyle = '#0a0a14';
    ctx.beginPath();
    ctx.arc(0, r * 0.15, r * 0.36, 0, TAU);
    ctx.fill();
    ctx.fillStyle = `hsla(${50 - 50 * g.aim}, 100%, ${55 + 20 * g.aim}%, ${0.5 + 0.5 * g.aim})`;
    ctx.beginPath();
    ctx.arc(0, r * 0.15, r * (0.14 + 0.14 * g.aim), 0, TAU);
    ctx.fill();
    if (g.seek > 0.2) {
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.2 + 0.5 * g.seek})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, r * 0.15, r * 0.5, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  function ship(p, x) {
    const y = p.y;
    if (p.invuln > 0 && Math.floor(clock * 12) % 2 === 0 && !reduced) return;
    ctx.save();
    ctx.translate(x, y);
    if (p.invuln > 0 && reduced) ctx.globalAlpha = 0.55;
    const flame = reduced ? 10 : 8 + 5 * Math.sin(clock * 50);
    const fg = ctx.createLinearGradient(0, 10, 0, 18 + flame);
    fg.addColorStop(0, 'rgba(120, 240, 255, 0.95)');
    fg.addColorStop(1, 'rgba(60, 120, 255, 0)');
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-5, 10);
    ctx.lineTo(0, 18 + flame);
    ctx.lineTo(5, 10);
    ctx.fill();
    ctx.shadowColor = '#5ef2ff';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#5ef2ff';
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.lineTo(17, 12);
    ctx.lineTo(6, 8);
    ctx.lineTo(0, 13);
    ctx.lineTo(-6, 8);
    ctx.lineTo(-17, 12);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#e9fdff';
    ctx.beginPath();
    ctx.ellipse(0, -2, 3.5, 7, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function draw(state, alpha, dt) {
    clock += dt;
    resize();
    const lerp = (a, b) => a + (b - a) * alpha;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (shake > 0 && !reduced) {
      ctx.translate((fxRand() - 0.5) * shake, (fxRand() - 0.5) * shake);
    }
    shake = Math.max(0, shake - dt * 30);
    background(clock);
    defenseLine(state);

    for (const e of state.enemies) {
      if (e.delay > 0) continue;
      drone(e, lerp(e.px, e.x), lerp(e.py, e.y));
    }

    ctx.fillStyle = '#b8fbff';
    for (const b of state.bullets) {
      const y = lerp(b.py, b.y);
      ctx.fillRect(b.x - 1.5, y - 9, 3, 14);
    }
    for (const s of state.shots) {
      const x = lerp(s.px, s.x), y = lerp(s.py, s.y);
      ctx.fillStyle = 'rgba(255, 70, 160, 0.35)';
      ctx.beginPath();
      ctx.arc(x, y, CONFIG.shotRadius + 3, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#ffd0ec';
      ctx.beginPath();
      ctx.arc(x, y, CONFIG.shotRadius - 1, 0, TAU);
      ctx.fill();
    }

    if (state.phase !== 'gameover') ship(state.player, lerp(state.player.px, state.player.x));

    for (const r of rings) {
      r.life -= dt;
      r.r += dt * 160;
      ctx.strokeStyle = `hsla(${r.hue}, 90%, 65%, ${Math.max(0, r.life * 1.6).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, TAU);
      ctx.stroke();
    }
    rings = rings.filter((r) => r.life > 0);
    for (const p of particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.96;
      p.vy *= 0.96;
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = `hsla(${p.hue}, 95%, ${60 + 30 * a}%, ${a.toFixed(3)})`;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    particles = particles.filter((p) => p.life > 0);

    if (banner && banner.t > 0) {
      banner.t -= dt;
      const a = Math.min(1, banner.t * 2);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#f2f4ff';
      ctx.font = '700 34px system-ui, sans-serif';
      ctx.fillText(banner.text, WORLD.w / 2, WORLD.h * 0.42);
      ctx.fillStyle = '#9fb3ff';
      ctx.font = '500 15px system-ui, sans-serif';
      ctx.fillText(banner.sub, WORLD.w / 2, WORLD.h * 0.42 + 28);
      ctx.restore();
    }
  }

  return {
    draw,
    consume,
    reset,
    resize,
    toWorldX,
    setReducedMotion(v) {
      reduced = !!v;
      if (reduced) shake = 0;
    },
  };
}
