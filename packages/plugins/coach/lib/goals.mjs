// Coach goals (coach spec section 4.6; plan Task 12b): how the person wants to improve, in their own
// words, up to 3 active. Each goal maps to measures and detectors; cards that serve a goal rank
// first (the gate rule still applies: it runs in detect, before ranking). The Coach also suggests
// goals from what it sees. Goals live in the memory document (`memory.goals`), so they are part of
// "What the Coach knows" and of every model call. Pure functions, except mapGoal (one model call).
import { normalizeMemory } from './memory.mjs';
import { DETECTORS } from './detectors.mjs';
import { planCall } from './plan.mjs';
import { parseAnswer } from './prompts.mjs';

export const MAX_ACTIVE = 3;
const MEASURE_IDS = ['ambition', 'delegation', 'reuse', 'judgment', 'breadth'];
const ORDER = ['judgment', 'reuse', 'ambition', 'delegation', 'breadth'];
const LABEL = { ambition: 'Ambition', delegation: 'Delegation', reuse: 'Reuse', judgment: 'Judgment', breadth: 'Breadth' };

/** The detectors that serve each measure. */
export const DETECTORS_OF = Object.freeze(Object.fromEntries(MEASURE_IDS.map((m) => [m, Object.keys(DETECTORS).filter((id) => DETECTORS[id].measure === m)])));

/** One suggested goal per measure: a short line, verb first. */
const SUGGESTION = Object.freeze({
  reuse: 'Automate the work I repeat each week',
  delegation: 'Run more things at once',
  ambition: 'Hand off whole tasks, not single steps',
  judgment: 'Plan first and check the results',
  breadth: 'Use AI for a new kind of work',
});
/** One next step per measure, for the recap. */
const NEXT = Object.freeze({
  reuse: 'Turn one repeated prompt into a schedule.',
  delegation: 'Start a second thread while one runs.',
  ambition: 'Give it one whole task this week.',
  judgment: 'Ask for a plan before a big task.',
  breadth: 'Try it on one new kind of work.',
});

const iso = (now) => (now instanceof Date ? now : new Date(now)).toISOString();
const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now));

export const activeGoals = (memory) => normalizeMemory(memory).goals.filter((g) => g.status === 'active');

/** Add a goal: { memory, ok, goal? }. Refused (ok false) with 3 active goals or an empty text. */
export function addGoal(memory, { text, measures, detectors, source }, now = new Date()) {
  const m = normalizeMemory(memory);
  const t = String(text || '').trim().slice(0, 140);
  if (!t || activeGoals(m).length >= MAX_ACTIVE) return { memory: m, ok: false };
  const goal = {
    id: `g${toMs(now).toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t,
    measures: (measures || []).filter((x) => MEASURE_IDS.includes(x)), detectors: (detectors || []).filter((x) => x in DETECTORS),
    source: source === 'suggested' ? 'suggested' : 'user', addedAt: iso(now), status: 'active',
  };
  return { memory: { ...m, goals: [...m.goals, goal] }, ok: true, goal };
}

export function setGoalStatus(memory, id, status, now = new Date()) {
  const m = normalizeMemory(memory);
  return { ...m, goals: m.goals.map((g) => (g.id === id ? { ...g, status, ...(status === 'done' ? { doneAt: iso(now) } : {}) } : g)) };
}

/** Change a goal's words; `mapped` (optional) replaces its measures and detectors. */
export function editGoal(memory, id, text, mapped = null) {
  const m = normalizeMemory(memory);
  const t = String(text || '').trim().slice(0, 140);
  if (!t) return m;
  return { ...m, goals: m.goals.map((g) => (g.id === id ? { ...g, text: t, ...(mapped ? { measures: mapped.measures, detectors: mapped.detectors } : {}) } : g)) };
}

/**
 * Up to 3 goals to suggest: the weakest measure first, then the measures whose detectors fired most,
 * then the rest by score. A measure an active goal covers is not suggested again.
 */
export function suggestGoals(_state, measures, memory, candidates = null) {
  const covered = new Set(activeGoals(memory).flatMap((g) => g.measures));
  const order = [];
  const push = (id) => { if (id && !order.includes(id) && !covered.has(id)) order.push(id); };
  const scored = MEASURE_IDS.filter((id) => measures && measures[id] && measures[id].enough)
    .sort((a, b) => measures[a].score - measures[b].score || ORDER.indexOf(a) - ORDER.indexOf(b));
  push(scored[0]);
  const fired = {};
  for (const c of (candidates && Array.isArray(candidates.items) ? candidates.items : [])) { const d = DETECTORS[c.type]; if (d) fired[d.measure] = (fired[d.measure] || 0) + 1; }
  for (const [id] of Object.entries(fired).sort((a, b) => b[1] - a[1] || ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]))) push(id);
  for (const id of scored) push(id);
  for (const id of ORDER) push(id);
  return order.slice(0, MAX_ACTIVE).map((id) => ({ text: SUGGESTION[id], measures: [id], detectors: [...DETECTORS_OF[id]] }));
}

const KEYWORDS = [
  ['reuse', /\b(automat\w*|schedul\w*|template\w*|repeat\w*|routine|reuse|every (day|week|monday|morning)|weekly|daily|monday)\b/i],
  ['delegation', /\b(parallel|at once|same time|more things|multiple threads|in the background|while i wait|delegat\w*)\b/i],
  ['ambition', /\b(whole|entire|bigger|end to end|full|hand off|complete)\b/i],
  ['judgment', /\b(plan\w*|check\w*|verify|review\w*|tests?|accura\w*|mistakes?|errors?|right)\b/i],
  ['breadth', /\b(new kinds?|different|research|forecast\w*|analy\w*|other kinds?|more kinds?|types of)\b/i],
];
/** The measures and detectors a goal's words point to, without a model. Nothing matched: ambition (think bigger). */
export function keywordMap(text) {
  const s = String(text || '');
  const measures = KEYWORDS.filter(([, re]) => re.test(s)).map(([id]) => id);
  const ms = measures.length ? measures : ['ambition'];
  return { measures: ms, detectors: ms.flatMap((m) => DETECTORS_OF[m]) };
}

const MAP_SYSTEM = [
  'You map a person\'s goal for how they work with AI to measures and detectors. Answer only with JSON:',
  '{"measures": [...], "detectors": [...]}.',
  `Measures: ${MEASURE_IDS.join(', ')}. Detectors: ${Object.keys(DETECTORS).map((id) => `${id} (${DETECTORS[id].measure})`).join(', ')}.`,
  'Pick one or two measures and the detectors that serve them.',
].join('\n');

/**
 * Map a goal's free text: one small-tier call (planCall 'confirm') through `assist(req)` (the web
 * part's d.assist, bound to the plugin), else the keywords. Unknown ids are dropped.
 */
export async function mapGoal(text, { assist, settings, budget }) {
  const fallback = () => ({ ...keywordMap(text), via: 'keywords' });
  if (typeof assist !== 'function') return fallback();
  const plan = planCall('confirm', settings, budget);
  if (plan.tier === 'none') return fallback();
  let r = null;
  try { r = await assist({ system: MAP_SYSTEM, messages: [{ role: 'user', content: `The goal: ${String(text).slice(0, 300)}` }], maxTokens: 200, harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) }); } catch { return fallback(); }
  const j = parseAnswer(r && (typeof r.text === 'string' ? r.text : r.result && r.result.text));
  const measures = j && Array.isArray(j.measures) ? j.measures.filter((x) => MEASURE_IDS.includes(x)) : [];
  if (!measures.length) return fallback();
  const detectors = Array.isArray(j.detectors) ? j.detectors.filter((x) => x in DETECTORS) : [];
  return { measures, detectors: detectors.length ? detectors : measures.flatMap((m) => DETECTORS_OF[m]), via: 'model' };
}

/** The goal a candidate serves: its detector, or its measure, is in an active goal. */
export function goalFor(c, goals) {
  return goals.find((g) => g.detectors.includes(c.type)) || goals.find((g) => g.measures.includes(c.measure)) || null;
}

/**
 * Goal-serving candidates first (tagged `goal`), then by the weight feedback gave each type; the
 * order given breaks ties. The gate is not undone here: detect already dropped what it gates.
 */
export function rankCandidates(candidates, memory) {
  const m = normalizeMemory(memory);
  const goals = m.goals.filter((g) => g.status === 'active');
  return candidates
    .map((c, i) => { const g = goalFor(c, goals); return { c: g ? { ...c, goal: g.id } : c, serves: !!g, w: m.weights[c.type] || 0, i }; })
    .sort((a, b) => Number(b.serves) - Number(a.serves) || b.w - a.w || a.i - b.i)
    .map((x) => x.c);
}

/** What moved for a goal this month, and one next step (the recap). */
export function goalProgress(goal, measures) {
  const id = goal.measures[0] || 'ambition';
  const m = measures && measures[id];
  const progress = !m || !m.enough ? 'Not enough data yet to see a change.'
    : m.trend > 0 ? `${LABEL[id]} went up this month.` : m.trend < 0 ? `${LABEL[id]} went down this month.` : `${LABEL[id]} held steady this month.`;
  return { id: goal.id, text: goal.text, progress, next: NEXT[id] };
}
