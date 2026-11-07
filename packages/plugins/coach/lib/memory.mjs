// Coach memory (coach spec section 4.4; plan Task 11): what the Coach knows about how this person
// works, built only from their feedback. A memory, not model training: it goes into the context of
// every model call. Pure functions over the `memory` document; the web part saves what they return.
//
// Shape: { facts: { id, text, source, at, confirmedAt }[], known: type[], levelAdjust: { measure: n },
//          muted: { type, until, reason, at, reviewedAt? }[], weights: { type: n }, bad: { type, situation, at }[],
//          dates: { 'known:<type>' | 'level:<measure>' | 'goals:asked': at },
//          goals: { id, text, measures, detectors, source: 'user' | 'suggested', addedAt, status: 'active' | 'done' }[] }
// (goals: lib/goals.mjs, coach spec section 4.6)
// Facts never hold prompt content: only what the person typed as a reason, after they confirm it.

export const REASONS = Object.freeze({
  already: 'I already do this',
  'not-relevant': 'Not relevant to my work',
  'too-basic': 'Too basic',
  'too-advanced': 'Too advanced',
  wrong: 'Wrong about what I did',
  'not-now': 'Not now',
});
export const RECONFIRM_DAYS = 180;
export const REVIEW_DAYS = 75;
const LEVEL_LIMIT = 3;
const DAY = 86400_000;
const MEASURE_WORD = { ambition: 'task size', delegation: 'handing off work', reuse: 'reuse', judgment: 'checking', breadth: 'new kinds of work' };
const TYPE_WORD = {
  'repeated-prompt': 'Repeated prompts', 'serial-independent': 'Threads run one after another', 'idle-wait': 'Waiting on one thread',
  'step-by-step': 'Step-by-step prompts', 'no-plan-big-task': 'Big tasks without a plan', 'fast-approve': 'Quick approvals', 'narrow-breadth': 'One kind of work',
  'plugin-fit': 'Repeated workflows',
};
export const typeLabel = (type) => TYPE_WORD[type] || type;

const iso = (now) => (now instanceof Date ? now : new Date(now)).toISOString();
const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now));

export function emptyMemory() {
  return { facts: [], known: [], levelAdjust: {}, muted: [], weights: {}, bad: [], dates: {}, goals: [] };
}

/** The saved document with every list present (an older or partial document stays usable). */
export function normalizeMemory(m) {
  const e = emptyMemory();
  if (!m || typeof m !== 'object') return e;
  return {
    facts: Array.isArray(m.facts) ? m.facts : e.facts, known: Array.isArray(m.known) ? m.known : e.known,
    levelAdjust: m.levelAdjust && typeof m.levelAdjust === 'object' ? m.levelAdjust : e.levelAdjust,
    muted: Array.isArray(m.muted) ? m.muted : e.muted, weights: m.weights && typeof m.weights === 'object' ? m.weights : e.weights,
    bad: Array.isArray(m.bad) ? m.bad : e.bad,
    dates: m.dates && typeof m.dates === 'object' ? m.dates : e.dates,
    goals: Array.isArray(m.goals) ? m.goals : e.goals,
  };
}

const clamp = (n) => Math.max(-LEVEL_LIMIT, Math.min(LEVEL_LIMIT, n));
const weigh = (m, type, by) => ({ ...m, weights: { ...m.weights, [type]: (m.weights[type] || 0) + by } });

/**
 * One piece of feedback on a card. Each reason has one exact effect; `effect` says it in one line.
 * `reason` is a chip (REASONS), or 'up' (👍), 'down' (👎 with no chip), 'fewer' or 'off' (the ⋯ menu).
 * Free text becomes `proposedFact`, saved only by confirmFact. `undo` is the memory as it was.
 */
export function applyFeedback(memory, fb, now = new Date()) {
  const before = normalizeMemory(memory);
  const type = fb.cardType;
  const at = iso(now);
  let m = before;
  let effect;
  let rest = false;
  switch (fb.reason) {
    case 'already':
      m = { ...m, known: m.known.includes(type) ? m.known : [...m.known, type], dates: { ...m.dates, [`known:${type}`]: at } };
      effect = 'Got it. No more tips on this: you already do it.'; break;
    case 'not-relevant':
      m = { ...m, muted: [...m.muted.filter((x) => x.type !== type), { type, until: null, reason: 'not-relevant', at }] };
      effect = 'Got it. No more tips of this kind.'; break;
    case 'too-basic':
      m = { ...m, levelAdjust: { ...m.levelAdjust, [fb.measure]: clamp((m.levelAdjust[fb.measure] || 0) + 1) }, dates: { ...m.dates, [`level:${fb.measure}`]: at } };
      effect = `Got it. Tips on ${MEASURE_WORD[fb.measure] || fb.measure} will aim higher.`; break;
    case 'too-advanced':
      m = { ...m, levelAdjust: { ...m.levelAdjust, [fb.measure]: clamp((m.levelAdjust[fb.measure] || 0) - 1) }, dates: { ...m.dates, [`level:${fb.measure}`]: at } };
      effect = `Got it. Tips on ${MEASURE_WORD[fb.measure] || fb.measure} will start simpler.`; break;
    case 'wrong':
      m = { ...m, bad: [...m.bad, { type, situation: fb.situation || null, at }] };
      effect = 'Got it. The Coach will not suggest this for that situation again.'; break;
    case 'not-now':
      rest = true;
      effect = 'Paused. The Coach may suggest this another time.'; break;
    case 'up':
      m = weigh(m, type, 1); effect = 'Thanks. More tips like this.'; break;
    case 'fewer':
      m = weigh(m, type, -2); effect = 'Got it. Fewer tips like this.'; break;
    case 'off':
      m = { ...m, muted: [...m.muted.filter((x) => x.type !== type), { type, until: null, reason: 'off', at }] };
      effect = 'Got it. This type of tip is off. Turn it back on in What the Coach knows.'; break;
    default: // 'down': a 👎 with no reason only lowers the weight; it never mutes a type
      m = weigh(m, type, -1); effect = 'Thanks. Fewer tips like this.';
  }
  const text = typeof fb.text === 'string' ? fb.text.trim().slice(0, 300) : '';
  const out = { memory: m, effect, undo: before, rest };
  if (text) out.proposedFact = { id: `f${toMs(now).toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, source: fb.headline ? `Feedback on "${fb.headline}"` : 'Your feedback', at, confirmedAt: null };
  return out;
}

/** Save a fact the person confirmed (or re-confirm one already saved). */
export function confirmFact(memory, fact, now = new Date()) {
  const m = normalizeMemory(memory);
  const saved = { ...fact, confirmedAt: iso(now) };
  const has = m.facts.some((f) => f.id === fact.id);
  return { ...m, facts: has ? m.facts.map((f) => (f.id === fact.id ? saved : f)) : [...m.facts, saved] };
}

export function editFact(memory, id, text, now = new Date()) {
  const m = normalizeMemory(memory);
  return { ...m, facts: m.facts.map((f) => (f.id === id ? { ...f, text: String(text).trim(), confirmedAt: iso(now) } : f)) };
}

/** Delete one item of "What the Coach knows": a fact, a known skill, a level adjustment or a muted type. */
export function removeItem(memory, kind, key) {
  const m = normalizeMemory(memory);
  if (kind === 'fact') return { ...m, facts: m.facts.filter((f) => f.id !== key) };
  if (kind === 'goal') return { ...m, goals: m.goals.filter((g) => g.id !== key) };
  const dates = { ...m.dates }; delete dates[`${kind}:${key}`];
  if (kind === 'known') return { ...m, known: m.known.filter((k) => k !== key), dates };
  if (kind === 'level') { const levelAdjust = { ...m.levelAdjust }; delete levelAdjust[key]; return { ...m, levelAdjust, dates }; }
  if (kind === 'muted') return { ...m, muted: m.muted.filter((x) => x.type !== key) };
  return m;
}

/** May the Coach propose this candidate (or show this card), given what it knows? Weights only rank; they never block. */
export function allows(memory, c, now = new Date()) {
  const m = normalizeMemory(memory);
  if (m.known.includes(c.type)) return false;
  const t = toMs(now);
  if (m.muted.some((x) => x.type === c.type && (x.until === null || Date.parse(x.until) > t))) return false;
  if (m.bad.some((x) => x.type === c.type && x.situation && x.situation === c.id)) return false;
  return true;
}

/** Facts whose last confirmation is older than 6 months: the Coach asks "Still true?". */
export function factsToReconfirm(memory, now = new Date()) {
  const t = toMs(now);
  return normalizeMemory(memory).facts.filter((f) => t - Date.parse(f.confirmedAt || f.at) > RECONFIRM_DAYS * DAY);
}

/** Types muted for good, 75 days or more ago, not yet reviewed: "You muted X in August. Show these again?" (once). */
export function dueForReview(memory, now = new Date()) {
  const t = toMs(now);
  return normalizeMemory(memory).muted.filter((x) => x.until === null && !x.reviewedAt && t - Date.parse(x.at) >= REVIEW_DAYS * DAY);
}

export function reviewMuted(memory, type, showAgain, now = new Date()) {
  const m = normalizeMemory(memory);
  if (showAgain) return { ...m, muted: m.muted.filter((x) => x.type !== type) };
  return { ...m, muted: m.muted.map((x) => (x.type === type ? { ...x, reviewedAt: iso(now) } : x)) };
}

export function resetMemory() { return emptyMemory(); }

/** The card history (or the worker's candidates) without the excerpts of what the person wrote (Reset). */
export function stripExcerpts(doc) {
  if (!doc || !Array.isArray(doc.items)) return doc;
  return {
    ...doc,
    items: doc.items.map((c) => {
      const { excerpt: _e, ...rest } = c;
      if (rest.more && typeof rest.more === 'object') { const { wrote: _w, ...more } = rest.more; rest.more = more; }
      if (rest.evidence && typeof rest.evidence === 'object') { const { excerpt: _x, ...evidence } = rest.evidence; rest.evidence = evidence; }
      return rest;
    }),
  };
}

/** Every item the Coach knows, for "What the Coach knows": nothing hidden. */
export function memoryItems(memory) {
  const m = normalizeMemory(memory);
  const out = [];
  for (const f of m.facts) out.push({ kind: 'fact', key: f.id, label: f.text, source: f.source || 'Your feedback', at: f.confirmedAt || f.at });
  for (const k of m.known) out.push({ kind: 'known', key: k, label: `You already do this: ${typeLabel(k)}`, source: 'You said "I already do this"', at: m.dates[`known:${k}`] || '' });
  for (const [measure, n] of Object.entries(m.levelAdjust)) if (n) out.push({ kind: 'level', key: measure, label: `Tips on ${MEASURE_WORD[measure] || measure}: ${n > 0 ? 'aim higher' : 'start simpler'} (${n > 0 ? '+' : ''}${n})`, source: n > 0 ? 'You said "Too basic"' : 'You said "Too advanced"', at: m.dates[`level:${measure}`] || '' });
  for (const g of m.goals) out.push({ kind: 'goal', key: g.id, label: `Goal: ${g.text}${g.status === 'done' ? ' (done)' : ''}`, source: g.source === 'suggested' ? 'Suggested by the Coach' : 'You set this goal', at: g.addedAt });
  for (const x of m.muted) out.push({ kind: 'muted', key: x.type, label: `Off: ${typeLabel(x.type)}`, source: x.reason === 'not-relevant' ? 'You said "Not relevant to my work"' : 'You turned this type off', at: x.at });
  return out;
}
