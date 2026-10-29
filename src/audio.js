// Procedural sound effects. Nothing is created until the player turns sound
// on, so the AudioContext always starts from a user gesture.

export function createAudio() {
  let ctx = null;
  let master = null;
  let noise = null;
  let enabled = false;
  const last = new Map();

  function changeState(method) {
    try {
      const result = ctx[method]();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* Sound is optional when the browser denies it. */ }
  }

  function init() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = noise.getChannelData(0);
      let x = 12345;
      for (let i = 0; i < data.length; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (x / 0x3fffffff - 1) * (1 - i / data.length);
      }
      return true;
    } catch {
      if (ctx) changeState('close');
      ctx = master = noise = null;
      return false;
    }
  }

  function tone(type, f0, f1, dur, vol, delay = 0) {
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function burst(dur, vol, freq) {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(80, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur);
  }

  const SOUNDS = {
    shot: () => tone('square', 880, 1320, 0.06, 0.05),
    enemyShot: () => tone('triangle', 420, 180, 0.12, 0.05),
    absorb: () => tone('square', 220, 160, 0.08, 0.07),
    kill: () => { burst(0.28, 0.35, 2400); tone('sawtooth', 300, 60, 0.2, 0.06); },
    escape: () => { tone('sawtooth', 160, 90, 0.4, 0.1); tone('sawtooth', 163, 92, 0.4, 0.08); },
    playerHit: () => { burst(0.6, 0.5, 1200); tone('sine', 140, 40, 0.5, 0.2); },
    waveClear: () => [523, 659, 784, 1047].forEach((f, i) => tone('triangle', f, f, 0.16, 0.08, i * 0.09)),
    waveStart: () => tone('sine', 196, 392, 0.35, 0.06),
    extraLife: () => [784, 988, 1175].forEach((f, i) => tone('square', f, f, 0.1, 0.05, i * 0.07)),
    gameover: () => [392, 330, 262, 196].forEach((f, i) => tone('triangle', f, f * 0.98, 0.3, 0.1, i * 0.18)),
  };

  return {
    get enabled() {
      return enabled;
    },
    // Must be called from a click or key handler.
    toggle() {
      if (!ctx && !init()) return false;
      enabled = !enabled;
      if (enabled && ctx.state === 'suspended') changeState('resume');
      if (!enabled && ctx.state === 'running') changeState('suspend');
      return enabled;
    },
    suspend() {
      if (ctx && ctx.state === 'running') changeState('suspend');
    },
    resume() {
      if (ctx && enabled && ctx.state === 'suspended') changeState('resume');
    },
    play(type) {
      if (!enabled || !ctx || ctx.state !== 'running' || !SOUNDS[type]) return;
      const now = ctx.currentTime;
      if (now - (last.get(type) || 0) < 0.035) return;
      last.set(type, now);
      try { SOUNDS[type](); } catch { enabled = false; }
    },
  };
}
