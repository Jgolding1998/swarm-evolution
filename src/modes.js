// Finite campaigns share the original survival rules and stop at their target.
export const RUN_MODES = Object.freeze({
  campaign: Object.freeze({label: 'Campaign', waves: 12, description: 'Hold 12 waves to complete the campaign.'}),
  extended: Object.freeze({label: 'Long campaign', waves: 24, description: 'Hold 24 waves for a longer campaign.'}),
  endless: Object.freeze({label: 'Endless', waves: null, description: 'The original survival game. Continue until the defense falls.'}),
});

export function runMode(value, fallback = 'endless') {
  return typeof value === 'string' && Object.hasOwn(RUN_MODES, value) ? value : fallback;
}
