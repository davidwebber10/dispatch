// Coach settings: every behavior has a setting with a default (coach spec section 2). The web
// part and the worker both read settings through withDefaults, so a saved partial document (or
// one from an older version) always has every field.

/** Detector thresholds (Settings → Coach → Advanced). Starting points, not findings (spec section 10). */
export const DEFAULT_THRESHOLDS = Object.freeze({
  repeatedPrompt: { count: 3, days: 14 },
  serialIndependent: { threads: 3, maxMinutes: 30, windowHours: 8 },
  idleWait: { minutes: 3 },
  stepByStep: { prompts: 5, minutes: 30, maxChars: 160 },
  noPlanBigTask: { minChars: 400, minParts: 3 },
  fastApprove: { seconds: 10, longTurnMinutes: 2 },
  narrowBreadth: { share: 0.9, days: 30, minThreads: 10 },
  pluginFit: { minRepeats: 3, days: 30, minSteps: 3 },
});

export const DEFAULT_SETTINGS = Object.freeze({
  howOften: 'normal',          // off | quiet | normal | chatty
  maxPerDay: 3,
  maxPerSession: 1,
  quietHours: null,            // { from: 'HH:MM', to: 'HH:MM' } (local time; may wrap midnight)
  phone: false,
  tipTypes: { prompt: true, thinkBigger: true },
  leaveAlone: [],              // project ids
  thoroughness: 'balanced',    // economy | balanced | thorough | budget
  model: { mode: 'auto' },     // or { small: { harness, model }, large: { harness, model } }
  budgetPercentWeekly: 3,
  budgetUsdWeekly: 5,
  recap: { inApp: true, push: false },
  advanced: { thresholds: DEFAULT_THRESHOLDS, minConfidence: 0.7 },
});

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A deep merge of plain objects; arrays and scalars from `over` replace the default. */
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? clone(base) : over;
  if (!isObj(base)) return clone(over);
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) out[k] = k in over ? merge(base[k], over[k]) : clone(base[k]);
  return out;
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** The saved settings with every missing field filled from the defaults. */
export function withDefaults(saved) {
  return merge(DEFAULT_SETTINGS, isObj(saved) ? saved : {});
}
