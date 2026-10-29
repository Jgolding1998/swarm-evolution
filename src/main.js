// Browser entry point: wires the simulation, renderer, input, audio and UI.

import { createGame, startGame, restartGame, step, setPaused, drainEvents, DT } from './sim.js';
import { consumeFrame } from './loop.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { loadBest, saveBest } from './storage.js';
import { hashSeed } from './rng.js';

const $ = (id) => document.getElementById(id);

function readOptions() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('seed');
  const seeded = Boolean(raw && /^[A-Za-z0-9_-]{1,32}$/.test(raw));
  const seed = seeded ? hashSeed(raw) : (Date.now() ^ (performance.now() * 1000)) >>> 0;
  const evolve = params.get('mode') !== 'control';
  return { seed, evolve, seeded };
}

const opts = readOptions();
const canvas = $('game');
const renderer = createRenderer(canvas);
const audio = createAudio();
const ui = createUI();
let best = loadBest();
let state = createGame(opts);
let acc = 0;
let lastTime = null;

const overlay = $('overlay');
const panels = { title: $('panel-title'), pause: $('panel-pause'), over: $('panel-over') };

function showPanel(name) {
  overlay.hidden = !name;
  for (const [k, p] of Object.entries(panels)) p.hidden = k !== name;
  if (name) panels[name].querySelector('button')?.focus({ preventScroll: true });
}

function focusField() {
  canvas.focus({ preventScroll: true });
}

function launch() {
  if (state.phase !== 'ready') return;
  startGame(state);
  showPanel(null);
  focusField();
}

function restart() {
  state = restartGame(state, opts.seeded ? opts.seed : (state.seed + 0x9e3779b9) >>> 0);
  renderer.reset();
  ui.reset();
  input.clear();
  acc = 0;
  lastTime = null;
  showPanel(null);
  syncPause();
  audio.resume();
  focusField();
}

function pause(on, reason = '') {
  input.clear();
  acc = 0;
  lastTime = null;
  if (setPaused(state, on)) {
    $('pause-reason').textContent = reason || 'Take a breath. The swarm waits.';
    showPanel('pause');
    audio.suspend();
  } else if (!state.paused && state.phase !== 'ready' && state.phase !== 'gameover') {
    showPanel(null);
    audio.resume();
    focusField();
  }
  syncPause();
}

function syncPause() {
  const btn = $('btn-pause');
  btn.setAttribute('aria-pressed', String(state.paused));
  btn.textContent = state.paused ? 'Resume' : 'Pause';
}

function toggleSound() {
  const on = audio.toggle();
  const btn = $('btn-sound');
  btn.setAttribute('aria-pressed', String(on));
  btn.textContent = on ? 'Sound on' : 'Sound off';
}

function toggleIntel() {
  const panel = $('intel');
  const open = !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  $('btn-intel').setAttribute('aria-expanded', String(open));
}

function onCommand(cmd) {
  switch (cmd) {
    case 'launch':
      launch();
      break;
    case 'start':
      if (state.phase === 'ready') launch();
      else if (state.phase === 'gameover') restart();
      else if (state.paused) pause(false);
      break;
    case 'pause':
      if (state.phase === 'playing' || state.phase === 'intermission') pause(!state.paused);
      break;
    case 'mute':
      toggleSound();
      break;
    case 'restart':
      if (state.phase !== 'ready') restart();
      break;
    case 'intel':
      toggleIntel();
      break;
    default:
      break;
  }
}

const input = createInput({ canvas, toWorldX: renderer.toWorldX, onCommand });

// Buttons. Pointer clicks drop focus back to the field so Space keeps firing.
function bind(id, fn) {
  $(id).addEventListener('click', (ev) => {
    fn();
    if (ev.detail > 0 && document.activeElement === ev.currentTarget && !overlay.contains(ev.currentTarget)) focusField();
  });
}
bind('btn-start', launch);
bind('btn-resume', () => pause(false));
bind('btn-again', restart);
bind('btn-pause', () => onCommand('pause'));
bind('btn-sound', toggleSound);
bind('btn-restart', restart);
bind('btn-intel', toggleIntel);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    input.clear();
    if (!state.paused) pause(true, 'Paused while the tab was hidden.');
    audio.suspend();
  }
});
window.addEventListener('blur', () => input.clear());

const motion = globalThis.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
renderer.setReducedMotion(!!(motion && motion.matches));
if (motion && motion.addEventListener) motion.addEventListener('change', (e) => renderer.setReducedMotion(e.matches));

function announce(text) {
  $('announcer').textContent = text;
}

function handleEvents(events) {
  renderer.consume(events);
  for (const ev of events) {
    audio.play(ev.type);
    if (ev.type === 'waveStart') announce(`Wave ${ev.wave}`);
    else if (ev.type === 'waveClear') announce(`Wave ${ev.wave} cleared. Breeding the next wave.`);
    else if (ev.type === 'gameover') {
      best = saveBest(ev.score, ev.wave);
      $('over-summary').textContent = `Score ${ev.score.toLocaleString('en-US')} on wave ${ev.wave}.`;
      $('over-best').textContent = `Best ${best.best.toLocaleString('en-US')}, furthest wave ${best.wave}.`;
      announce(`Game over. Score ${ev.score}.`);
      showPanel('over');
    }
  }
}

function frame(now) {
  const elapsed = lastTime == null ? 0 : (now - lastTime) / 1000;
  lastTime = now;
  let alpha = 1;
  if (!state.paused && state.phase !== 'ready' && state.phase !== 'gameover') {
    const r = consumeFrame(acc, elapsed, DT);
    acc = r.acc;
    alpha = r.alpha;
    const inp = input.sample();
    for (let i = 0; i < r.steps; i++) step(state, inp);
  } else {
    acc = 0;
  }
  const events = drainEvents(state);
  if (events.length) handleEvents(events);
  renderer.draw(state, alpha, state.paused ? 0 : Math.min(elapsed, 0.1));
  ui.hudUpdate(state, Math.max(best.best, state.score));
  ui.intelUpdate(state);
  requestAnimationFrame(frame);
}

if (!opts.evolve) $('intel-title').textContent = 'Swarm intel (control)';
showPanel('title');
ui.hudUpdate(state, best.best);
requestAnimationFrame(frame);
