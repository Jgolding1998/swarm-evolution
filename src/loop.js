// Fixed-step accumulator. Real frame time is clamped so a stalled tab or a
// slow device never triggers a burst of catch-up steps.

export const MAX_FRAME = 0.25;
export const MAX_STEPS = 6;

export function consumeFrame(accumulator, elapsed, dt) {
  const frame = Number.isFinite(elapsed) && elapsed > 0 ? Math.min(elapsed, MAX_FRAME) : 0;
  let acc = accumulator + frame;
  let steps = Math.floor(acc / dt + 1e-9);
  if (steps > MAX_STEPS) {
    steps = MAX_STEPS;
    acc = 0; // drop the backlog instead of spiralling
  } else {
    acc -= steps * dt;
  }
  return { steps, acc: Math.max(0, acc), alpha: Math.max(0, Math.min(1, acc / dt)) };
}
