// Browser entry point: wires the simulation, renderer, input, audio and UI.

import { createGame, startGame, restartGame, step, setPaused, drainEvents, DT } from './sim.js';
import { consumeFrame } from './loop.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createUI } from './ui.js';
import { loadBest, loadModeBest, saveModeBest } from './storage.js';
import { hashSeed } from './rng.js';
import { RUN_MODES, runMode } from './modes.js';

const $ = (id) => document.getElementById(id);

function readOptions() {
  const params = new URLSearchParams(location.search);
  const raw = params.get('seed');
  const seeded = Boolean(raw && /^[A-Za-z0-9_-]{1,32}$/.test(raw));
  const seed = seeded ? hashSeed(raw) : (Date.now() ^ (performance.now() * 1000)) >>> 0;
  const evolve = params.get('mode') !== 'control';
  return { seed, evolve, seeded, runMode: runMode(params.get('run'), 'campaign') };
}

const opts = readOptions();
const canvas = $('game');
const renderer = createRenderer(canvas);
const audio = createAudio(({enabled, busy, kind, message}) => {
  const button = $('btn-sound');
  button.disabled = busy;
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = busy ? 'Enabling sound...' : enabled ? 'Sound on' : kind === 'unavailable' ? 'Sound unavailable' : 'Sound off';
  $('sound-status').textContent = message;
  $('sound-status').dataset.kind = kind;
});
const ui = createUI();
let best = loadModeBest(opts.runMode, opts.evolve);
let state = createGame(opts);
let acc = 0;
let lastTime = null;
const modeSelect = $('run-mode');
modeSelect.value = opts.runMode;
const legacy = loadBest();
if (legacy.best || legacy.wave) {
  $('legacy-best').hidden = false;
  $('legacy-best').textContent = `Legacy best ${legacy.best.toLocaleString('en-US')} / wave ${legacy.wave} (old mixed-rule record).`;
}

function selectedMode() { return runMode(modeSelect.value, 'campaign'); }
function modeStatus() {
  const selected = selectedMode();
  $('run-mode-status').textContent = RUN_MODES[selected].description +
    (state.phase !== 'ready' && selected !== state.runMode ? ` Restart to apply; current run is ${RUN_MODES[state.runMode].label}.` : ' Restart starts a new run.');
  const displayed = state.phase === 'ready' ? selected : state.runMode;
  if (state.phase === 'ready') best = loadModeBest(displayed, state.evolve);
  $('hud-best-label').textContent = `${RUN_MODES[displayed].label} ${state.evolve ? 'evolving' : 'control'} best`;
}
modeSelect.addEventListener('change', modeStatus);

// Reserve the actual wrapped toolbar height, including sound feedback and
// translated/browser-sized text, so the ship stays inside the viewport.
function fitField() {
  const layout = document.querySelector('.layout'), style = getComputedStyle(layout);
  const free = innerHeight - (layout.getBoundingClientRect().top + scrollY) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  document.documentElement.style.setProperty('--field-space', `${Math.max(120, Math.floor(free))}px`);
}
if (globalThis.ResizeObserver) {
  const size = new ResizeObserver(fitField);
  size.observe(document.querySelector('.topbar'));
  size.observe(document.querySelector('.run-settings'));
}
addEventListener('resize', fitField);
fitField();

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
  if (state.runMode !== selectedMode()) state = createGame({...opts, runMode: selectedMode()});
  best = loadModeBest(state.runMode, state.evolve);
  ui.reset();
  startGame(state);
  audio.resume();
  modeStatus();
  showPanel(null);
  focusField();
}

function restart() {
  state = restartGame(state, opts.seeded ? opts.seed : (state.seed + 0x9e3779b9) >>> 0, selectedMode());
  best = loadModeBest(state.runMode, state.evolve);
  renderer.reset();
  ui.reset();
  input.clear();
  acc = 0;
  lastTime = null;
  showPanel(null);
  syncPause();
  audio.resume();
  focusField();
  modeStatus();
}

function pause(on, reason = '') {
  input.clear();
  acc = 0;
  lastTime = null;
  if (setPaused(state, on)) {
    $('pause-reason').textContent = reason || 'Take a breath. The swarm waits.';
    showPanel('pause');
    audio.suspend();
  } else if (!state.paused && state.phase !== 'ready' && state.phase !== 'gameover' && state.phase !== 'won') {
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
  audio.toggle();
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
      else if (state.phase === 'gameover' || state.phase === 'won') restart();
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
  if (state.phase === 'won') events = events.filter(ev => ev.type !== 'extraLife');
  renderer.consume(events);
  for (const ev of events) {
    audio.play(ev.type);
    if (ev.type === 'waveStart') announce(`Wave ${ev.wave}`);
    else if (ev.type === 'waveClear') announce(`Wave ${ev.wave} cleared.${state.phase === 'won' ? '' : ' Breeding the next wave.'}`);
    else if (ev.type === 'gameover' || ev.type === 'campaignClear') {
      best = saveModeBest(ev.score, ev.wave, state.runMode, state.evolve);
      const won = ev.type === 'campaignClear';
      $('over-title').textContent = won ? 'Campaign complete' : 'Defense broken';
      $('over-summary').textContent = `${won ? `All ${ev.wave} waves held. ` : ''}Score ${ev.score.toLocaleString('en-US')} on wave ${ev.wave}.`;
      $('over-best').textContent = `${RUN_MODES[state.runMode].label} ${state.evolve ? 'evolving' : 'control'} best ${best.best.toLocaleString('en-US')}, furthest wave ${best.wave}.`;
      announce(`${won ? 'Campaign complete' : 'Game over'}. Score ${ev.score}.`);
      showPanel('over');
    }
  }
}

function frame(now) {
  const elapsed = lastTime == null ? 0 : (now - lastTime) / 1000;
  lastTime = now;
  let alpha = 1;
  if (!state.paused && state.phase !== 'ready' && state.phase !== 'gameover' && state.phase !== 'won') {
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
modeStatus();
ui.hudUpdate(state, best.best);
requestAnimationFrame(frame);
