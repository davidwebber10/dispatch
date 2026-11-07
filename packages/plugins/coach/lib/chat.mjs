// Talk with the Coach (coach spec section 4.9; plan Task 12e). The Coach answers from what it has
// observed (the measures, the signals and their evidence, the cards and the feedback, the goals
// and the memory) and cites it. With too little data it says so plainly: what it has seen, what it
// needs to see, and roughly when. It never invents a pattern; general advice is labeled general.
// Pure helpers; the web part makes the call (the large tier, under the budget).
import { normalizeMemory, typeLabel } from './memory.mjs';
import { activeDays as countActiveDays, MIN_ACTIVE_DAYS } from './recap.mjs';

export const CHAT_KEEP = 200;
const HISTORY_IN_PROMPT = 12;
const LABEL = { ambition: 'Ambition', delegation: 'Delegation', reuse: 'Reuse', judgment: 'Judgment', breadth: 'Breadth' };
const ACTION_KINDS = new Set(['add-goal', 'create-skill', 'schedule', 'build-plugin', 'new-threads']);
const ms = (iso) => Date.parse(iso);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const minutes = (x) => Math.round(x / 60_000);

/** What the Coach sees in one thread (the right-column tab, and the chat's thread scope). */
export function threadObservations(state, terminalId) {
  if (!state || !terminalId) return [];
  const prompts = (state.prompts || []).filter((p) => p.t === terminalId);
  const turns = (state.turns || []).filter((x) => x.t === terminalId);
  if (!prompts.length && !turns.length) return [];
  const out = [];
  const work = turns.reduce((n, x) => n + x.ms, 0);
  const longest = turns.reduce((n, x) => Math.max(n, x.ms), 0);
  out.push(`You sent ${plural(prompts.length, 'prompt', 'prompts')}; the agent worked ${plural(minutes(work), 'minute', 'minutes')} on its own (the longest stretch ${plural(minutes(longest), 'minute', 'minutes')}).`);
  const big = prompts.filter((p) => p.len > 400 || p.parts >= 3);
  out.push(prompts.some((p) => p.plan) ? 'You asked for a plan.' : 'You did not ask for a plan first.');
  if (big.length) out.push(`${plural(big.length, 'prompt was a big task', 'prompts were big tasks')} (3 parts or more).`);
  const fast = prompts.filter((p) => p.ok && p.gap !== null && p.gap >= 0 && p.gap <= 10_000 && p.prev >= 2 * 60_000).length;
  if (fast) out.push(`You approved ${plural(fast, 'long answer', 'long answers')} within seconds.`);
  const first = prompts[0];
  if (first) {
    const others = new Set((state.prompts || []).filter((p) => p.t !== terminalId && p.h === first.h).map((p) => p.t));
    if (others.size) out.push(`Its first prompt repeats ${plural(others.size, 'other thread', 'other threads')}.`);
  }
  return out;
}

/**
 * What the chat may say about the person: observations (each a line it can cite), whether there
 * is enough data, the active days, and what it still needs. `opts.terminalId` scopes to a thread.
 */
export function chatContext(state, measures, memory, cards, opts = {}) {
  const now = opts.now || new Date();
  const m = normalizeMemory(memory);
  const days = countActiveDays(state || {}, now);
  const observations = [];
  if (opts.terminalId) for (const line of threadObservations(state, opts.terminalId)) observations.push(`In this thread: ${line}`);
  let enoughMeasure = false;
  for (const id of Object.keys(LABEL)) {
    const x = measures && measures[id];
    if (!x || !x.enough) continue;
    enoughMeasure = true;
    observations.push(`${LABEL[id]}: ${x.score} of 100 over 30 days, trend ${x.trend > 0 ? 'up' : x.trend < 0 ? 'down' : 'steady'}.`);
  }
  for (const c of (cards || []).slice(-10)) observations.push(`Card "${c.headline}" (${typeLabel(c.type)}): ${c.reason || c.why}`);
  for (const g of m.goals) if (g.status === 'active') observations.push(`Goal: ${g.text}`);
  for (const f of m.facts) if (f.confirmedAt) observations.push(`Fact: ${f.text}`);
  for (const k of m.known) observations.push(`Already does: ${typeLabel(k)}`);
  for (const x of m.muted) observations.push(`Turned off: ${typeLabel(x.type)}`);
  const prompts = ((state && state.prompts) || []).length;
  const enoughData = days >= MIN_ACTIVE_DAYS && (enoughMeasure || (cards || []).length > 0);
  const needs = enoughData ? '' : `The Coach has seen ${plural(days, 'active day', 'active days')} and ${plural(prompts, 'prompt', 'prompts')}. It needs about ${MIN_ACTIVE_DAYS} active days of work to see patterns${days < MIN_ACTIVE_DAYS ? `: about ${MIN_ACTIVE_DAYS - days} more` : ''}.`;
  return { observations, enoughData, activeDays: days, needs, scope: opts.terminalId ? 'thread' : 'me' };
}

export const CHAT_SYSTEM = [
  'You are the Coach inside Dispatch, an app where people work with AI agents in threads. You talk with one person about how they use AI and how to improve.',
  'Claims about the person come only from the observations given: cite them ("in 4 of your last 6 threads..."). Never invent a pattern, a number or a habit.',
  'When the data says there is too little data, say so plainly: what you have seen, what you need to see, and roughly when you will have something.',
  'You may answer general questions about using AI; label such an answer as general advice, not an observation.',
  'Short answers, plain words, US spelling. Never write "should". No jargon for business users.',
  'Answer only with JSON: {"text": "your answer", "actions": [optional, at most 3 (5 at most are shown): {"kind": "add-goal", "payload": {"text": "..."}} | {"kind": "create-skill", "payload": {"name": "...", "description": "...", "body": "..."}} | {"kind": "schedule", "payload": {"prompt": "...", "cron": "min hour dom mon dow", "label": "..."}} | {"kind": "build-plugin", "payload": {"plugin": "what it does", "parts": ["view" | "button" | "worker" | "hook"]}} | {"kind": "new-threads", "payload": {"prompts": ["..."]}}]}',
].join('\n');

/** The chat call: the fixed system text, then the observations, the recent history and the question. */
export function chatPrompt(ctx, history, question) {
  const lines = [
    `Scope: ${ctx.scope === 'thread' ? 'this thread, and the person' : 'the person'}.`,
    ctx.enoughData ? 'There is enough data for observations.' : `There is too little data. ${ctx.needs}`,
    ctx.observations.length ? `Observations:\n${ctx.observations.map((o) => `- ${o}`).join('\n')}` : 'Observations: none yet.',
  ];
  const recent = (history || []).slice(-HISTORY_IN_PROMPT);
  if (recent.length) lines.push(`The conversation so far:\n${recent.map((t) => `${t.role === 'user' ? 'Person' : 'Coach'}: ${t.text}`).join('\n')}`);
  lines.push(`The person asks: ${String(question).slice(0, 2000)}`);
  return { system: CHAT_SYSTEM, messages: [{ role: 'user', content: lines.join('\n\n') }], maxTokens: 900 };
}

/** The answer: { text, actions } with only known action kinds; plain text is an answer too; null when empty. */
export function parseChat(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (j && typeof j.text === 'string' && j.text.trim()) {
        const actions = Array.isArray(j.actions) ? j.actions.filter((a) => a && ACTION_KINDS.has(a.kind) && a.payload && typeof a.payload === 'object').slice(0, 5) : [];
        return { text: j.text.trim(), actions };
      }
    } catch { /* not JSON: the text is the answer */ }
  }
  return { text: s, actions: [] };
}

/** The chat document with new turns, newest CHAT_KEEP kept. */
export function appendTurns(doc, turns) {
  const prev = doc && Array.isArray(doc.turns) ? doc.turns : [];
  return { ...(doc || {}), turns: [...prev, ...turns].slice(-CHAT_KEEP) };
}
