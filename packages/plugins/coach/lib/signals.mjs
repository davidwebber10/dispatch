// Coach signals (coach spec section 6; plan Task 8): folds the daemon's thread events into a small,
// rolling state the detectors read. Pure functions: the worker and the tests share them.
//
// Privacy: a prompt is kept as features (length, lines, parts, a hash of its normalized text) and a
// 200-character excerpt for the card's "You wrote". The full text is never kept. Prompts from peers,
// the Control Plane or the daemon (source !== 'user') and every event from a left-alone project are
// dropped here.

export const EXCERPT_CHARS = 200;
const KEEP_DAYS = 31;
const KEEP_PROMPTS = 600;
const KEEP_TURNS = 600;
/** Only the newest prompts keep their excerpt: the document stays far under the 256 KB limit. */
const KEEP_EXCERPTS = 60;

export function emptyState() {
  return { v: 1, prompts: [], turns: [], threads: {}, open: {}, last: {} };
}

/** Lowercase, words only, single spaces: two prompts that differ in case, spacing or punctuation match. */
export function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A short, stable hash (FNV-1a, base 36) of the normalized text. */
export function hashText(text) {
  let h = 0x811c9dc5;
  const s = normalize(text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const KINDS = [
  ['code', /\b(fix|bug|tests?|refactor|deploy|code|function|class|api|compile|commit|merge|repo|typescript|javascript|python|sql|endpoint|lint|build)\b/],
  ['data', /\b(spreadsheet|excel|csv|reconcile|dataset|data|table|formula|pivot|sheet)\b/],
  ['analysis', /\b(analy[sz]e|analysis|trend|forecast|metrics?|kpis?|variance)\b/],
  ['research', /\b(research|investigate|compare|look up|sources|vendors?|competitors?|options)\b/],
  ['writing', /\b(write|draft|email|reply|letter|blog|post|rewrite|proofread|memo|message)\b/],
  ['planning', /\b(plan|roadmap|schedule|agenda|strategy|outline|prioriti[sz]e)\b/],
];
/** The kind of work a thread is, from its first prompt (coach spec section 3, Breadth). */
export function classify(text) {
  const s = String(text || '').toLowerCase();
  for (const [kind, re] of KINDS) if (re.test(s)) return kind;
  return 'other';
}

const APPROVE_RE = /^(?!.*\b(but|except|change|fix|instead)\b)(lgtm|looks good|looks great|ship it|go ahead|perfect|great|yes|yep|ok|okay|approved?|do it|sounds good|merge it|good)\b[\s\p{P}\w]{0,30}$/iu;
const PLAN_RE = /\b(plan|planning|outline|propose|approach first|before you start|step[- ]by[- ]step plan)\b/i;

/** Parts of a prompt: sentences and list items of three words or more. */
export function countParts(text) {
  return String(text || '').split(/\n+|(?<=[.!?;])\s+/).map((x) => x.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim()).filter((x) => x.split(/\s+/).length >= 3).length;
}

const ms = (iso) => Date.parse(iso);
const leftAlone = (settings, projectId) => !!(settings && Array.isArray(settings.leaveAlone) && settings.leaveAlone.includes(projectId));

/** Fold one event into the state; returns a new state (the input is not changed). */
export function collect(event, state, settings) {
  const e = event || {};
  if (typeof e.type !== 'string' || !e.terminalId || !e.at) return state;
  if (leftAlone(settings, e.sessionId)) return state;
  const s = { ...state, prompts: state.prompts, turns: state.turns, threads: { ...state.threads }, open: { ...state.open }, last: { ...state.last } };
  const t = e.terminalId;
  const p = e.sessionId || null;
  if (e.type === 'thread:prompt') {
    if (e.source !== 'user' || typeof e.text !== 'string') return state;
    const text = e.text;
    const prev = s.last[t];
    const trimmed = text.trim();
    const rec = {
      t, p, at: e.at,
      ex: trimmed.slice(0, EXCERPT_CHARS),
      h: hashText(text),
      len: text.length,
      lines: trimmed ? trimmed.split(/\n/).length : 0,
      parts: countParts(text),
      plan: PLAN_RE.test(text),
      ok: trimmed.length <= 40 && APPROVE_RE.test(trimmed),
      gap: prev ? ms(e.at) - ms(prev.end) : null,
      prev: prev ? prev.ms : null,
    };
    s.prompts = [...s.prompts, rec];
    const th = s.threads[t];
    s.threads[t] = th ? { ...th, prompts: th.prompts + 1 } : { p, first: e.at, end: null, kind: classify(text), prompts: 1, tools: 0 };
    if (!s.open[t]) s.open[t] = e.at;
  } else if (e.type === 'thread:turn') {
    const len = typeof e.ms === 'number' && e.ms >= 0 ? e.ms : (s.open[t] ? ms(e.at) - ms(s.open[t]) : 0);
    const start = new Date(ms(e.at) - len).toISOString();
    s.turns = [...s.turns, { t, p, start, end: e.at, ms: len, outcome: e.outcome || null }];
    s.last[t] = { end: e.at, ms: len };
    const th = s.threads[t];
    s.threads[t] = th ? { ...th, end: e.at } : { p, first: start, end: e.at, kind: 'other', prompts: 0, tools: 0 };
    delete s.open[t];
  } else if (e.type === 'thread:tool') {
    const th = s.threads[t];
    if (th) s.threads[t] = { ...th, tools: (th.tools || 0) + 1 };
  } else if (e.type === 'terminal:status') {
    // The browser hears these (the worker does not): an idle thread is no longer busy.
    if (e.status === 'idle' || e.threadStatus === 'idle') delete s.open[t];
    else return state;
  } else return state;
  return prune(s, e.at);
}

/** Drop what is older than the longest window, cap the lists, and keep excerpts only on the newest prompts. */
export function prune(s, nowIso) {
  const cutoff = ms(nowIso) - KEEP_DAYS * 86400_000;
  let prompts = s.prompts.filter((x) => ms(x.at) >= cutoff).slice(-KEEP_PROMPTS);
  if (prompts.length > KEEP_EXCERPTS) prompts = prompts.map((x, i) => (i < prompts.length - KEEP_EXCERPTS && x.ex ? { ...x, ex: '' } : x));
  const turns = s.turns.filter((x) => ms(x.end) >= cutoff).slice(-KEEP_TURNS);
  const threads = {};
  for (const [id, th] of Object.entries(s.threads)) if (ms(th.end || th.first) >= cutoff) threads[id] = th;
  const last = {};
  for (const [id, v] of Object.entries(s.last)) if (threads[id]) last[id] = v;
  return { ...s, prompts, turns, threads, last };
}
