// Procedural sound effects. Context creation and confirmation need an explicit
// Sound gesture. The same tone graph can be rendered by OfflineAudioContext.

export const VOICE_LIMIT = 32;

export function scheduleTone(ctx, destination, type, f0, f1, dur, vol, delay = 0, onEnd = () => {}) {
  const t = ctx.currentTime + 0.02 + delay;
  const oscillator = ctx.createOscillator(), gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(f0, t);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  oscillator.connect(gain).connect(destination);
  oscillator.onended = () => {
    oscillator.disconnect(); gain.disconnect(); onEnd(oscillator);
  };
  oscillator.start(t); oscillator.stop(t + dur + 0.02);
  return oscillator;
}

export function createAudio(onStatus = () => {}) {
  let ctx = null;
  let master = null;
  let noise = null;
  let enabled = false;
  let busy = false;
  let wantRunning = false;
  let epoch = 0;
  const last = new Map();
  const voices = new Set();

  function quiet(method) {
    try {
      const result = ctx?.[method]?.();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* Sound is optional when the browser denies it. */ }
  }

  function publish(kind, message) {
    try { onStatus({enabled, busy, kind, message}); } catch { /* UI callbacks cannot stop play. */ }
  }

  function unavailable() {
    enabled = busy = false;
    wantRunning = false;
    epoch++;
    quiet('close');
    ctx = master = noise = null;
    voices.clear();
    last.clear();
    publish('unavailable', 'Sound is blocked or unavailable. Press Sound to retry; the game still works.');
  }

  async function running(token) {
    const current = ctx;
    if (!current) return false;
    let timer;
    try {
      if (current.state !== 'running') await Promise.race([
        Promise.resolve(current.resume()),
        new Promise((resolve, reject) => {timer = setTimeout(() => reject(new Error('Audio start timed out')), 3000);}),
      ]);
      if (token !== epoch) {
        if (!wantRunning || current !== ctx) {
          try { current.suspend()?.catch?.(() => {}); } catch { /* A newer pause or Sound off wins. */ }
        }
        return false;
      }
      if (current.state !== 'running') throw new Error('Audio did not start');
      return true;
    } catch {
      if (token === epoch) unavailable();
      return false;
    } finally { clearTimeout(timer); }
  }

  function init() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.4;
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
      if (ctx) quiet('close');
      ctx = master = noise = null;
      return false;
    }
  }

  function tone(type, f0, f1, dur, vol, delay = 0) {
    if (voices.size >= VOICE_LIMIT) return;
    const source = scheduleTone(ctx, master, type, f0, f1, dur, vol, delay, node => voices.delete(node));
    voices.add(source);
  }

  function burst(dur, vol, freq) {
    if (voices.size >= VOICE_LIMIT) return;
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
    src.onended = () => {src.disconnect(); f.disconnect(); g.disconnect(); voices.delete(src);};
    voices.add(src);
    src.start(t);
    src.stop(t + dur);
  }

  const SOUNDS = {
    confirm: () => tone('triangle', 660, 880, 0.15, 0.18),
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
    campaignClear: () => [523, 784, 1047, 1568].forEach((f, i) => tone('triangle', f, f, 0.2, 0.08, i * 0.12)),
  };

  return {
    get enabled() {
      return enabled;
    },
    // Must be called from a click or key handler.
    async toggle() {
      if (busy) return enabled;
      if (enabled) {
        epoch++; enabled = false; wantRunning = false; quiet('suspend');
        publish('off', 'Sound off.');
        return false;
      }
      if (!ctx && !init()) {unavailable(); return false;}
      busy = true;
      wantRunning = true;
      const token = ++epoch;
      publish('pending', 'Enabling sound...');
      const ok = await running(token);
      if (token !== epoch) return enabled;
      enabled = ok; busy = false;
      if (enabled) {
        this.play('confirm');
        if (enabled) publish('on', 'Sound enabled. A short test tone was sent; check tab and device volume if silent.');
      }
      return enabled;
    },
    suspend() {
      const wasBusy = busy;
      epoch++; busy = false;
      wantRunning = false;
      quiet('suspend');
      if (enabled) publish('paused', 'Sound paused with the game.');
      else if (wasBusy) publish('off', 'Sound was paused before it started. Press Sound to retry.');
    },
    async resume() {
      if (!ctx || !enabled) return false;
      wantRunning = true;
      const token = ++epoch;
      const ok = await running(token);
      if (ok && token === epoch) publish('on', 'Sound enabled. Check tab and device volume if silent.');
      return ok;
    },
    play(type) {
      if (!enabled || !ctx || ctx.state !== 'running' || !SOUNDS[type]) return;
      const now = ctx.currentTime;
      if (last.has(type) && now - last.get(type) < 0.035) return;
      last.set(type, now);
      try { SOUNDS[type](); } catch { unavailable(); }
    },
  };
}
