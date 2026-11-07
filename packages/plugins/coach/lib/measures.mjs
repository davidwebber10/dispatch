// Coach measures (coach spec section 3; plan Task 12): five scores from 0 to 100, each from the
// signals of the last 30 days. They compare a person only with their own past: the trend is the
// change from the scores of about 30 days before (the worker keeps a daily snapshot), never a
// comparison with other people. Pure functions: the worker computes them, the web part shows them.

export const MEASURE_IDS = Object.freeze(['ambition', 'delegation', 'reuse', 'judgment', 'breadth']);
/** On a tie, the measure that comes first here is the weakest: judgment first (the gate, spec section 3). */
const TIE_ORDER = ['judgment', 'reuse', 'ambition', 'delegation', 'breadth'];
const WINDOW_DAYS = 30;
const DAY = 86400_000;
/** At least this many prompts (threads for breadth) in the window before a score counts. */
export const MIN_PROMPTS = 10;
export const MIN_THREADS = 5;
/** A change of this many points is a trend up or down. */
const TREND_POINTS = 5;
const KEEP_HISTORY = 45;

const ms = (iso) => Date.parse(iso);
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const toMs = (now) => (now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : Number(now));

/** A whole task, not one step: a long prompt, or one with three parts or more. */
const isWhole = (p) => p.len >= 200 || p.parts >= 3;
const isBig = (p) => p.len > 400 || p.parts >= 3;

function scoresOf(state, t) {
  const from = t - WINDOW_DAYS * DAY;
  const prompts = (state.prompts || []).filter((p) => ms(p.at) >= from && ms(p.at) <= t);
  const turns = (state.turns || []).filter((x) => ms(x.end) >= from && ms(x.end) <= t);
  const threads = Object.entries(state.threads || {}).filter(([, th]) => ms(th.first) >= from && ms(th.first) <= t && th.prompts > 0);
  const work = prompts.filter((p) => !p.ok);

  // Ambition: whole tasks over single steps, and turns that run a while on their own.
  const whole = work.length ? work.filter(isWhole).length / work.length : 0;
  const long = turns.length ? turns.filter((x) => x.ms >= 5 * 60_000).length / turns.length : 0;
  const ambition = 0.6 * whole + 0.4 * clamp01(long * 2);

  // Delegation: tool calls per prompt (the AI working between messages), and turns that overlap another thread's.
  const tools = threads.reduce((n, [, th]) => n + (th.tools || 0), 0);
  const perPrompt = prompts.length ? tools / prompts.length : 0;
  const overlap = turns.length ? turns.filter((x) => turns.some((y) => y.t !== x.t && ms(y.start) < ms(x.end) && ms(y.end) > ms(x.start))).length / turns.length : 0;
  const delegation = 0.5 * clamp01(perPrompt / 8) + 0.5 * clamp01(overlap * 2);

  // Reuse: the share of work prompts typed again and again (3 times or more) counts against it.
  const byHash = new Map();
  for (const p of work) byHash.set(p.h, (byHash.get(p.h) || 0) + 1);
  const repeated = work.length ? work.filter((p) => byHash.get(p.h) >= 3).length / work.length : 0;
  const reuse = 1 - clamp01(repeated * 2);

  // Judgment: a plan before big tasks, and no approvals within seconds of a long answer.
  const big = work.filter(isBig);
  const planned = big.length ? big.filter((p) => p.plan).length / big.length : 0.3;
  const oks = prompts.filter((p) => p.ok);
  const fast = oks.length ? oks.filter((p) => p.gap !== null && p.gap >= 0 && p.gap <= 10_000 && p.prev >= 2 * 60_000).length / oks.length : 0;
  const judgment = 0.6 * planned + 0.4 * (1 - fast);

  // Breadth: how many kinds of work, and how even.
  const kinds = {};
  for (const [, th] of threads) if (th.kind && th.kind !== 'other') kinds[th.kind] = (kinds[th.kind] || 0) + 1;
  const counted = Object.values(kinds).reduce((a, b) => a + b, 0);
  const top = counted ? Math.max(...Object.values(kinds)) / counted : 1;
  const breadth = 0.7 * clamp01(Object.keys(kinds).length / 4) + 0.3 * (1 - top);

  const enoughPrompts = prompts.length >= MIN_PROMPTS;
  return {
    ambition: { score: ambition, enough: enoughPrompts },
    delegation: { score: delegation, enough: enoughPrompts },
    reuse: { score: reuse, enough: enoughPrompts },
    judgment: { score: judgment, enough: enoughPrompts },
    breadth: { score: breadth, enough: threads.length >= MIN_THREADS },
  };
}

/**
 * The five measures now: { score 0..100, trend -1 | 0 | 1, enough }. `before` is the scores of about
 * 30 days ago ({ measure: score }); without it the trend is 0.
 */
export function measures(state, now, before = null) {
  const raw = scoresOf(state || {}, toMs(now));
  const out = {};
  for (const id of MEASURE_IDS) {
    const score = Math.round(raw[id].score * 100);
    const prev = before && typeof before[id] === 'number' ? before[id] : null;
    const trend = prev === null ? 0 : score - prev >= TREND_POINTS ? 1 : prev - score >= TREND_POINTS ? -1 : 0;
    out[id] = { score, trend, enough: raw[id].enough };
  }
  return out;
}

/**
 * The measure to work on: the lowest score among those with enough data. A level adjustment
 * ("Too basic" +1, "Too advanced" -1) moves a measure 10 points. Null when none has enough data.
 */
export function weakest(m, levelAdjust = {}) {
  let best = null;
  for (const id of TIE_ORDER) {
    const x = m && m[id];
    if (!x || !x.enough) continue;
    const v = x.score + 10 * ((levelAdjust && levelAdjust[id]) || 0);
    if (best === null || v < best.v) best = { id, v };
  }
  return best ? best.id : null;
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

/** The measures document's history with today's scores ({ measure: score }): one entry a day, the latest wins. */
export function snapshot(doc, scores, now) {
  const t = toMs(now);
  const day = dayOf(t);
  const history = (doc && Array.isArray(doc.history) ? doc.history : []).filter((h) => h.day !== day);
  return { ...(doc || {}), history: [...history, { day, at: new Date(t).toISOString(), scores }].slice(-KEEP_HISTORY) };
}

/** The scores of about 30 days ago: the newest snapshot at least 28 days old, or null. */
export function scoresBefore(doc, now) {
  const t = toMs(now);
  const old = (doc && Array.isArray(doc.history) ? doc.history : []).filter((h) => t - Date.parse(h.at) >= 28 * DAY);
  return old.length ? old[old.length - 1].scores : null;
}

/** { measure: score } from a measures() result. */
export const scoresOnly = (m) => Object.fromEntries(MEASURE_IDS.map((id) => [id, m[id].score]));
