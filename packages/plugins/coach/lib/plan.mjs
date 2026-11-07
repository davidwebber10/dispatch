// Coach plan (coach spec section 5; plan Task 9): which model tier a step uses, by thoroughness and
// budget. Pure: the worker (the judge, the recap) and the web part ("More") share it.
//
// Steps: confirm (does a candidate fit; on Economy it also fills the card), write (the large model
// writes the card), more (the detail behind "More"), review-thread, review-prompt, recap.

/** The large model of each harness when the person picked none (Automatic). */
export const LARGE_DEFAULT = Object.freeze({ claude: 'opus', codex: 'gpt-6.1-sol', openrouter: '~anthropic/claude-opus-latest' });

/** The tier of each step at each level; small-only is Economy near its cap ("drop to the small model only"). */
const TABLE = Object.freeze({
  'small-only': { confirm: 'small', write: 'none', more: 'none', 'review-thread': 'none', 'review-prompt': 'none', recap: 'none' },
  economy: { confirm: 'small', write: 'none', more: 'large', 'review-thread': 'none', 'review-prompt': 'none', recap: 'large' },
  balanced: { confirm: 'small', write: 'large', more: 'large', 'review-thread': 'large', 'review-prompt': 'none', recap: 'large' },
  thorough: { confirm: 'large', write: 'large', more: 'large', 'review-thread': 'large', 'review-prompt': 'large', recap: 'large' },
});
const LADDER = ['small-only', 'economy', 'balanced', 'thorough'];
export const STEP_DOWN_AT = Object.freeze([0.8, 0.9]);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** How much of the cap is spent, 0..1+, or null when the daemon has not said (no budget, no headers yet). */
export function budgetFraction(budget) {
  if (!budget) return null;
  const usedP = num(budget.usedPercent); const capP = num(budget.capPercent);
  if (usedP !== null && capP !== null && capP > 0) return usedP / capP;
  const usedU = num(budget.usedUsd); const capU = num(budget.capUsd);
  if (usedU !== null && capU !== null && capU > 0) return usedU / capU;
  if (capU === 0) return 1;
  return null;
}

/**
 * The level the Coach runs at now: the chosen thoroughness (Use my budget starts at Thorough), one
 * level down at 80% of the cap, two at 90%; below small-only is rules only ('none'); at the cap, 'none'.
 */
export function effectiveLevel(settings, budget) {
  const chosen = settings && settings.thoroughness;
  const start = chosen === 'budget' ? 'thorough' : (LADDER.includes(chosen) && chosen !== 'small-only' ? chosen : 'balanced');
  const f = budgetFraction(budget);
  if (f !== null && f >= 1 - 1e-9) return { level: 'none', stepped: true };
  const drop = f === null ? 0 : STEP_DOWN_AT.filter((x) => f >= x - 1e-9).length;
  const i = LADDER.indexOf(start) - drop;
  return { level: i < 0 ? 'none' : LADDER[i], stepped: drop > 0 };
}

/**
 * The tier, harness and model for one step. `ctx.harness` is where the last small call ran: with
 * Automatic, the large tier runs there too, with that harness's large model.
 */
export function planCall(step, settings, budget, ctx = {}) {
  const { level, stepped } = effectiveLevel(settings, budget);
  const tier = level === 'none' ? 'none' : (TABLE[level][step] || 'none');
  const out = { tier, level, stepped, harness: undefined, model: undefined };
  if (tier === 'none') return out;
  const m = (settings && settings.model) || { mode: 'auto' };
  const picked = m.mode !== 'auto' && m[tier] && m[tier].harness ? m[tier] : null;
  if (picked) return { ...out, harness: picked.harness, model: picked.model || undefined };
  if (tier === 'small') return { ...out, harness: 'auto' };
  const harness = ctx.harness && LARGE_DEFAULT[ctx.harness] ? ctx.harness : 'claude';
  return { ...out, harness, model: LARGE_DEFAULT[harness] };
}
