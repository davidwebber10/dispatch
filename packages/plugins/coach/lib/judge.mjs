// Coach judge (coach spec section 5, tiers 2 and 3; plan Task 9): a rule's candidate becomes a card
// only when a model confirms it. The small model checks fit and confidence (on Economy it also
// fills the card); on Balanced and up the large model writes it. A card is whole or not at all:
// a malformed or empty answer drops the candidate (the daemon meters the call either way).
//
// `assist(req)` is injected: it resolves to { result: { text, harness } | null, budget, refused }
// (lib/client.mjs in the worker). The worker joins the outcomes into the `cards` document.
import { planCall } from './plan.mjs';
import { confirmPrompt, writePrompt, parseAnswer, checkCard, cleanAction, cleanParts, buildPluginPrompt } from './prompts.mjs';

const KEEP_CARDS = 60;
const KEEP_JUDGED = 300;

/** The budget the daemon reported on an assist answer, or null when it sent none. */
export function budgetFromHeaders(headers) {
  const get = (k) => { const v = headers && typeof headers.get === 'function' ? headers.get(k) : null; const n = v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(n) ? n : null; };
  const usedPercent = get('X-Budget-Used-Percent'); const capPercent = get('X-Budget-Cap-Percent');
  if (usedPercent !== null || capPercent !== null) return { usedPercent, capPercent };
  const usedUsd = get('X-Budget-Used-Usd'); const capUsd = get('X-Budget-Cap-Usd');
  if (usedUsd !== null || capUsd !== null) return { usedUsd, capUsd };
  return null;
}

/** "Why am I seeing this?": what the rule saw, in plain words. */
export function reasonFor(c) {
  const e = c.evidence || {};
  switch (c.type) {
    case 'repeated-prompt': return `You sent the same prompt ${e.count} times in ${e.days} days.`;
    case 'serial-independent': return `You ran ${e.threads} short threads in one project one after another, over ${e.minutes} minutes.`;
    case 'idle-wait': return `One thread ran ${e.minutes} minutes while nothing else ran.`;
    case 'step-by-step': return `You sent ${e.prompts} one-line prompts in ${e.minutes} minutes in one thread.`;
    case 'no-plan-big-task': return `Your prompt had ${e.parts} parts and did not ask for a plan first.`;
    case 'fast-approve': return `You approved ${e.seconds} seconds after a ${e.turnMinutes}-minute answer.`;
    case 'plugin-fit': return `You ran the same ${e.steps}-step workflow ${e.repeats} times in ${e.days} days, and no schedule covers it.`;
    case 'narrow-breadth': return `${e.threads} of your ${e.total} threads in ${e.days} days were one kind of work (${e.kind}).`;
    default: return 'The Coach saw this in your recent threads.';
  }
}

/** A plugin-fit answer: whole only with a plugin line and at least one known part; the action is ours. */
function pluginAnswer(c, ans) {
  if (c.type !== 'plugin-fit' || !ans || typeof ans !== 'object') return ans;
  const parts = cleanParts(ans.parts);
  const plugin = typeof ans.plugin === 'string' ? ans.plugin.trim() : '';
  if (!plugin || !parts.length) return { ...ans, action: null };
  const excerpt = c.evidence && typeof c.evidence.excerpt === 'string' ? c.evidence.excerpt : '';
  return { ...ans, plugin, parts, action: { kind: 'plugin', label: 'Try it: build the plugin', prompt: buildPluginPrompt({ plugin, parts, excerpt }) } };
}

function cardOf(c, ans, at) {
  if (c.type === 'plugin-fit') {
    return { ...cardBase(c, ans, at), action: ans.action, plugin: ans.plugin, parts: ans.parts };
  }
  return cardBase(c, ans, at);
}
function cardBase(c, ans, at) {
  return {
    id: c.id, type: c.type, measure: c.measure, tip: c.tip, terminalId: c.terminalId ?? null, projectId: c.projectId ?? null,
    headline: ans.headline.trim(), why: ans.why.trim(), action: cleanAction(ans.action),
    excerpt: c.evidence && typeof c.evidence.excerpt === 'string' ? c.evidence.excerpt : '',
    reason: reasonFor(c), ...(c.goal ? { goal: c.goal } : {}), at,
  };
}

/**
 * Judge one candidate. Returns { card, outcome, calls, budget, harness }: outcome is 'card',
 * 'dropped' (no fit, unsure, malformed, empty: recorded, not tried again) or 'budget' (no call
 * could run: the candidate waits).
 */
export async function judgeCandidate(c, { settings, memory, budget, assist, now = new Date(), harness = null }) {
  const calls = [];
  let b = budget;
  let ran = harness;
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  const min = settings && settings.advanced ? settings.advanced.minConfidence : 0.7;
  const step = async (name, req, plan) => {
    const r = await assist({ ...req, harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) }).catch(() => ({ result: null, budget: null, refused: null }));
    if (r && r.budget) b = r.budget;
    if (r && r.refused) return { refused: true };
    if (r && r.result && r.result.harness) ran = r.result.harness;
    const ans = parseAnswer(r && r.result ? r.result.text : '');
    return { ans };
  };

  const p1 = planCall('confirm', settings, b, { harness: ran });
  if (p1.tier === 'none') return { id: c.id, card: null, outcome: 'budget', calls, budget: b, harness: ran };
  const r1 = await step('confirm', confirmPrompt(c, memory), p1);
  if (r1.refused) return { id: c.id, card: null, outcome: 'budget', calls, budget: b, harness: ran };
  r1.ans = pluginAnswer(c, r1.ans);
  const why1 = checkCard(r1.ans, min);
  calls.push({ step: 'confirm', tier: p1.tier, ok: !!r1.ans && why1 !== 'malformed' });
  if (why1) return { id: c.id, card: null, outcome: 'dropped', reason: why1, calls, budget: b, harness: ran };
  let final = r1.ans;

  const p2 = planCall('write', settings, b, { harness: ran });
  if (p2.tier !== 'none') {
    const r2 = await step('write', writePrompt(c, memory, r1.ans), p2);
    if (!r2.refused) {
      // The large model's card replaces the small one only when it is whole and keeps to the copy rules.
      const merged = r2.ans ? pluginAnswer(c, { ...r1.ans, ...r2.ans }) : null;
      const ok = !!merged && checkCard({ ...merged, fit: true, confidence: 1 }, 0) === null;
      calls.push({ step: 'write', tier: p2.tier, ok });
      if (ok) final = merged;
    }
  }
  return { id: c.id, card: cardOf(c, final, at), outcome: 'card', calls, budget: b, harness: ran };
}

/**
 * The `cards` document after a judge run: new cards join (newest last, capped), and every judged
 * candidate is recorded once in `judged` (card, dropped, or muted: found during a mute). A candidate
 * the budget stopped is not recorded: it is judged later.
 */
export function joinCards(doc, results, at) {
  const items = Array.isArray(doc && doc.items) ? doc.items : [];
  const judged = Array.isArray(doc && doc.judged) ? doc.judged : [];
  const have = new Set(items.map((c) => c.id));
  const newCards = results.filter((r) => r.outcome === 'card' && r.card && !have.has(r.card.id)).map((r) => r.card);
  const done = results.filter((r) => r.outcome !== 'budget').map((r) => ({ id: r.id || (r.card && r.card.id), at, outcome: r.outcome, calls: r.calls.length }));
  return { ...(doc || {}), items: [...items, ...newCards].slice(-KEEP_CARDS), judged: [...judged, ...done].slice(-KEEP_JUDGED) };
}

/** The candidates not yet judged, in the order given. */
export function unjudged(candidates, cardsDoc) {
  const seen = new Set([...(Array.isArray(cardsDoc && cardsDoc.judged) ? cardsDoc.judged.map((j) => j.id) : []), ...(Array.isArray(cardsDoc && cardsDoc.items) ? cardsDoc.items.map((c) => c.id) : [])]);
  return candidates.filter((c) => !seen.has(c.id));
}
