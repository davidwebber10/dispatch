// The Coach worker's engine (coach spec section 8): it folds the daemon's events into the signals
// state, runs the detectors when a turn ends, and judges new candidates into cards. All I/O is
// injected (`io`), so the tests drive it against a fake daemon; worker/index.mjs is the real shell.
//
// io: { getDoc(key, fallback), putDoc(key, value), getSettings(), assist(req) → { result, budget, refused },
//       notify({ title, body, url }), now(), log(...), readBudget?(harness) → budget | null | undefined }
//
// The budget: the assist headers update it, and the worker also reads it from the daemon
// (readBudget: GET /budget and /assist/share) at start, at least every 15 minutes, on a settings
// change, and before it settles on no call. A figure whose window has reset is stale (unknown).
//
// Documents: `signals` (lib/signals.mjs), `candidates` ({ items, seen }), `cards` ({ items, judged }),
// `status` ({ budget, level, stepped, at }: what the daemon last said about the budget), `measures`
// ({ at, scores, weakest, history }: lib/measures.mjs), `recap` (the weekly recap, lib/recap.mjs).
import { withDefaults } from './settings.mjs';
import { collect, emptyState } from './signals.mjs';
import { detect, proposeNew } from './detectors.mjs';
import { allows, normalizeMemory, emptyMemory } from './memory.mjs';
import { isMuted, mayShow } from './cadence.mjs';
import { effectiveLevel, planCall, liveBudget, mergeBudget } from './plan.mjs';
import { measures, weakest, snapshot, scoresBefore, scoresOnly } from './measures.mjs';
import { buildRecap } from './recap.mjs';
import { recapPrompt, parseAnswer } from './prompts.mjs';
import { rankCandidates, suggestGoals } from './goals.mjs';
import { planReview, chunkTranscript, reviewPrompt, parseReview, mergeReview, eventsFromTranscript, MAX_THREADS } from './review.mjs';
import { appendTurns } from './chat.mjs';
import { judgeCandidate, joinCards, unjudged } from './judge.mjs';

const SAVE_DELAY_MS = 5_000;
/** At most this many candidates are judged after one turn: each is a model call or two. */
export const JUDGE_PER_RUN = 3;
/** A candidate older than this is no longer "what you just did": it is not judged. */
export const FRESH_MS = 2 * 3600_000;
/** The budget is read from the daemon at least this often. */
export const BUDGET_TTL_MS = 15 * 60_000;
/** Before it settles on no call, the worker asks the daemon again, at most this often. */
const BEFORE_NONE_GAP_MS = 60_000;

export function createEngine(io) {
  let settings = withDefaults(null);
  let state = emptyState();
  let candidates = { items: [], seen: [] };
  let memory = emptyMemory();
  let status = { budget: null, budgetAt: null, level: null, stepped: false, at: null, harness: null };
  let lastRead = -Infinity;
  let measuresDoc = null;
  let saveTimer = null;
  let chain = Promise.resolve();
  const log = io.log || (() => {});
  const now = () => io.now();

  // One thing at a time: detection and judging never overlap (the documents stay consistent).
  const queue = (fn) => { chain = chain.then(fn).catch((err) => log('coach:', err && err.message ? err.message : err)); return chain; };

  async function loadSettings() { try { settings = withDefaults(await io.getSettings()); } catch (err) { log('settings:', err.message); } }
  async function loadMemory() { try { memory = normalizeMemory(await io.getDoc('memory', null)); } catch (err) { log('memory:', err.message); } }

  async function load() {
    await loadSettings();
    try {
      const saved = await io.getDoc('signals', null);
      if (saved && saved.v === 1) state = { ...emptyState(), ...saved };
      const c = await io.getDoc('candidates', null);
      if (c && Array.isArray(c.items)) candidates = c;
      const st = await io.getDoc('status', null);
      if (st && typeof st === 'object') status = { ...status, ...st };
      measuresDoc = await io.getDoc('measures', null);
      await loadMemory();
    } catch (err) { log('load failed:', err.message); }
    // A restart reads the budget again: never trust the last answer's headers alone.
    await readBudget(now());
  }

  /** The budget from the daemon's routes; a failed read keeps what the worker had. */
  async function readBudget(t) {
    if (typeof io.readBudget !== 'function') return;
    lastRead = t.getTime();
    let r;
    try { r = await io.readBudget(status.harness); } catch (err) { log('budget read failed:', err && err.message ? err.message : err); return; }
    if (r === undefined) return;
    status = { ...status, budget: r, budgetAt: t.toISOString() };
    await io.putDoc('status', status).catch((err) => log('status save failed:', err.message));
  }
  /** The budget to plan `step` with now: read again when old or stale, and once more before a 'none'. */
  async function currentBudget(t, step) {
    const age = status.budgetAt ? t.getTime() - Date.parse(status.budgetAt) : Infinity;
    if (age >= BUDGET_TTL_MS || (status.budget && !liveBudget(status.budget, t))) await readBudget(t);
    let b = liveBudget(status.budget, t);
    if (planCall(step, settings, b, { harness: status.harness }).tier === 'none' && t.getTime() - lastRead >= BEFORE_NONE_GAP_MS) {
      await readBudget(t);
      b = liveBudget(status.budget, t);
    }
    return b;
  }
  /** A budget an answer carried: kept, with the reset time the daemon gave before. */
  const heard = (b) => { status = { ...status, budget: mergeBudget(b, status.budget), budgetAt: now().toISOString() }; };

  function saveSoon() {
    if (saveTimer || io.saveDelayMs === 0) { if (io.saveDelayMs === 0) void io.putDoc('signals', state); return; }
    saveTimer = setTimeout(() => { saveTimer = null; io.putDoc('signals', state).catch((err) => log('signals save failed:', err.message)); }, io.saveDelayMs ?? SAVE_DELAY_MS);
  }
  async function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await io.putDoc('signals', state); }
  }

  async function judge() {
    const t = now();
    const cardsDoc = await io.getDoc('cards', null);
    const fresh = unjudged(candidates.items, cardsDoc).filter((c) => t.getTime() - Date.parse(c.at) < FRESH_MS && allows(memory, c, t));
    if (!fresh.length) return;
    const at = t.toISOString();
    // Nothing queues during a mute (coach spec section 4.3): the candidates are recorded as muted, never judged.
    const cadence = await io.getDoc('cadence', null);
    if (isMuted(cadence, t)) {
      await io.putDoc('cards', joinCards(cardsDoc, fresh.map((c) => ({ id: c.id, outcome: 'muted', card: null, calls: [] })), at));
      return;
    }
    const results = [];
    const before = await currentBudget(t, 'confirm');
    let budget = before;
    let harness = status.harness;
    // Newest first, then the ones that serve a goal before the rest (spec section 4.6).
    for (const c of rankCandidates([...fresh].reverse(), memory).slice(0, JUDGE_PER_RUN)) {
      const r = await judgeCandidate(c, { settings, memory, budget, assist: io.assist, now: t, harness });
      budget = r.budget; harness = r.harness;
      results.push(r);
      if (r.outcome === 'budget') break;
    }
    const lvl = effectiveLevel(settings, budget);
    const heardNew = budget !== before;
    status = { ...status, budget: heardNew ? mergeBudget(budget, status.budget) : status.budget, ...(heardNew ? { budgetAt: at } : {}), level: lvl.level, stepped: lvl.stepped, at, harness };
    await io.putDoc('status', status);
    if (results.some((r) => r.outcome !== 'budget')) {
      // Read again: the web part may have written the document (Reset) while the model answered.
      const latest = await io.getDoc('cards', cardsDoc);
      await io.putDoc('cards', joinCards(latest, results, at));
      for (const r of results) if (r.outcome === 'card') log(`card ${r.id}`);
    }
  }

  /** The five measures now, saved with a daily snapshot; returns the weakest (the gate reads it). */
  async function updateMeasures(t) {
    const m = measures(state, t, scoresBefore(measuresDoc, t));
    const w = weakest(m, memory.levelAdjust);
    // Suggested goals (spec section 4.6) ride along: the web part has no signals to compute them from.
    const suggestions = suggestGoals(state, m, memory, candidates);
    measuresDoc = { ...snapshot(measuresDoc, scoresOnly(m), t), at: t.toISOString(), scores: m, weakest: w, suggestions };
    await io.putDoc('measures', measuresDoc);
    return w;
  }

  async function runDetectors() {
    const t = now();
    const w = await updateMeasures(t);
    const found = rankCandidates(detect(state, settings, t, { weakest: w }).filter((c) => allows(memory, c, t)), memory);
    if (found.length) {
      const next = proposeNew(candidates, found, t);
      if (next.added.length) {
        candidates = { items: next.items, seen: next.seen };
        await io.putDoc('candidates', candidates);
        for (const c of next.added) log(`candidate ${c.id}`);
      }
    }
    await judge();
  }

  /**
   * The Monday recap (coach spec section 4.2): only after 5 active days, never when the Coach or the
   * in-app recap is off. During a mute or quiet hours it is written for the Coach screen but not
   * announced and not pushed. A push needs the recap push setting (Task 5's notify:push).
   */
  async function weekly() {
    const t = now();
    if (settings.howOften === 'off' || (settings.recap && settings.recap.inApp === false)) return;
    const w = await updateMeasures(t);
    const draft = buildRecap(state, { memory, measures: measuresDoc && measuresDoc.scores, now: t });
    if (!draft) { log('recap: fewer than 5 active days'); return; }
    let recap = { ...draft, weakest: w };
    const plan = planCall('recap', settings, await currentBudget(t, 'recap'), { harness: status.harness });
    if (plan.tier !== 'none') {
      const r = await io.assist({ ...recapPrompt(draft, memory), harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) }).catch(() => null);
      if (r && r.budget) heard(r.budget);
      const j = parseAnswer(r && r.result ? r.result.text : '');
      // The model may reword the lines; the stretch's action and the numbers stay the rules' own.
      const lines = j && Array.isArray(j.patterns) ? j.patterns.filter((x) => typeof x === 'string' && x.trim() && !/\bshould\b/i.test(x)) : [];
      if (lines.length === draft.patterns.length) recap = { ...recap, patterns: lines.map((x) => x.trim()) };
    }
    const cadence = await io.getDoc('cadence', null);
    const announce = mayShow(cadence, settings, t, 'recap');
    recap = { ...recap, at: t.toISOString(), announce };
    await io.putDoc('recap', recap);
    if (announce && settings.recap && settings.recap.push && io.notify) {
      const r = await io.notify({ title: 'Your week with AI', body: recap.patterns[0] || 'Your weekly recap is ready.', url: '/' }).catch(() => null);
      log(`recap push: ${r && r.ok ? 'sent' : 'not sent'}`);
    }
  }

  // ── reviews (spec section 4.10): `reviews:<id>` documents the web part writes and this job advances ──
  // planning → estimate (no model call) → queued (the person's Start) → reading → writing → done;
  // cancelled stops further calls; failed says why. Transcripts come from the conversation route.
  const running = new Set();
  const reviewWaits = new Set();
  const reviewsIdle = async () => { while (reviewWaits.size) await Promise.all([...reviewWaits]); };
  const getJson = (route) => (io.getJson ? io.getJson(route).catch(() => null) : Promise.resolve(null));
  async function scopeThreads(scope) {
    let rows = [];
    if (scope.kind === 'thread') {
      for (const id of scope.ids || []) { const t = await getJson(`/api/terminals/${encodeURIComponent(id)}`); if (t) rows.push({ id, sessionId: t.sessionId ?? null, at: t.lastActivityAt || t.createdAt || '' }); }
    } else {
      let projects = scope.kind === 'project' ? (scope.ids || []) : [];
      if (scope.kind === 'range') { const s = await getJson('/api/sessions'); projects = Array.isArray(s) ? s.map((x) => x.id) : (s && Array.isArray(s.sessions) ? s.sessions.map((x) => x.id) : []); }
      for (const p of projects) {
        const list = await getJson(`/api/sessions/${encodeURIComponent(p)}/terminals`);
        for (const t of Array.isArray(list) ? list : []) rows.push({ id: t.id, sessionId: t.sessionId ?? p, at: t.lastActivityAt || t.createdAt || '' });
      }
      if (scope.kind === 'range') {
        const from = Date.parse(scope.from || 0); const to = scope.to ? Date.parse(scope.to) : Infinity;
        rows = rows.filter((r) => { const a = Date.parse(r.at); return Number.isFinite(a) && a >= from && a <= to; });
      }
    }
    return rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, MAX_THREADS);
  }
  async function transcript(id) {
    const r = await getJson(`/api/terminals/${encodeURIComponent(id)}/conversation?limit=2000`);
    return r && Array.isArray(r.items) ? r.items : [];
  }
  async function writeReview(key, patch) {
    // Read again first: the person may have pressed Cancel since.
    const cur = (await io.getDoc(key, null)) || {};
    if (cur.cancel && patch.state !== 'cancelled') return { ...cur, cancelled: true };
    const next = { ...cur, ...patch, updatedAt: now().toISOString() };
    await io.putDoc(key, next);
    return next;
  }
  async function reviewStep(key) {
    if (running.has(key)) return;
    const doc = await io.getDoc(key, null);
    if (!doc || !doc.scope) return;
    if (doc.state === 'planning') {
      running.add(key);
      try {
        const rows = await scopeThreads(doc.scope);
        const threads = [];
        for (const r of rows) threads.push({ id: r.id, chunks: chunkTranscript(await transcript(r.id)).length });
        await writeReview(key, { state: 'estimate', plan: planReview(doc.scope, threads, await currentBudget(now(), 'more')) });
      } finally { running.delete(key); }
      return;
    }
    if (doc.state !== 'queued') return;
    running.add(key);
    try { await runReview(key, doc); } finally { running.delete(key); }
  }
  async function runReview(key, doc) {
    const ids = (doc.plan && Array.isArray(doc.plan.threads)) ? doc.plan.threads : (await scopeThreads(doc.scope)).map((r) => r.id);
    const parts = [];
    let read = 0;
    const seeded = [];
    for (let i = 0; i < ids.length; i++) {
      const w = await writeReview(key, { state: 'reading', progress: { done: i, total: ids.length } });
      if (w.cancelled || w.cancel) return;
      const items = await transcript(ids[i]);
      if (doc.backfill) { const t = await getJson(`/api/terminals/${encodeURIComponent(ids[i])}`); seeded.push(...eventsFromTranscript(ids[i], (t && t.sessionId) || null, items)); }
      const chunks = chunkTranscript(items);
      if (chunks.length) read++;
      for (const chunk of chunks) {
        const cur = await io.getDoc(key, null);
        if (!cur || cur.cancel || cur.state === 'cancelled') return;
        const plan = planCall('more', settings, await currentBudget(now(), 'more'), { harness: status.harness });
        if (plan.tier === 'none') { await writeReview(key, { state: 'failed', error: 'The Coach reached its budget for this week, so the review stopped.' }); return; }
        const r = await io.assist({ ...reviewPrompt(chunk, memory), harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) }).catch(() => null);
        if (r && r.budget) heard(r.budget);
        if (r && r.result && r.result.harness) status = { ...status, harness: r.result.harness };
        if (r && r.refused) { await writeReview(key, { state: 'failed', error: 'The Coach reached its budget for this week, so the review stopped.' }); return; }
        const p = parseReview(r && r.result ? r.result.text : '', chunk);
        if (p) parts.push(p);
      }
    }
    const w = await writeReview(key, { state: 'writing', progress: { done: ids.length, total: ids.length } });
    if (w.cancelled || w.cancel) return;
    const report = mergeReview(parts, { read });
    await writeReview(key, { state: 'done', report, finishedAt: now().toISOString() });
    if (doc.backfill && seeded.length) {
      // The look back seeds the signals with threads the Coach has not seen yet, then the measures.
      const known = new Set(Object.keys(state.threads || {}));
      let next = state;
      for (const e of seeded.filter((x) => !known.has(x.terminalId)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) next = collect(e, next, settings);
      state = next;
      await io.putDoc('signals', state);
      await updateMeasures(now());
    }
    const chat = await io.getDoc('chat', null);
    await io.putDoc('chat', appendTurns(chat, [{ role: 'coach', text: `Your ${doc.backfill ? 'look back' : 'review'} is ready. ${report.summary} The findings are on the Coach screen.`, at: now().toISOString(), review: doc.id || key }]));
    await io.putDoc('status', status);
  }

  function handle(e) {
    if (!e || typeof e.type !== 'string') return chain;
    if (e.type === 'plugin:data' && typeof e.key === 'string' && e.key.startsWith('reviews:') && !e.deleted) {
      const key = e.key;
      // A review runs beside the detection queue: a long review never holds up a card.
      const p = reviewStep(key).catch((err) => log('review:', err && err.message ? err.message : err)).finally(() => reviewWaits.delete(p));
      reviewWaits.add(p);
      return Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0))).then(() => reviewsIdle());
    }
    // A settings change may carry a new budget (the web part saves the daemon's budget first).
    if (e.type === 'plugin:settings') return queue(async () => { await loadSettings(); await readBudget(now()); });
    if (e.type === 'plugin:data') {
      if (e.key === 'memory') return queue(loadMemory);
      // Reset (What the Coach knows) drops the signals: follow it.
      if (e.key === 'signals' && e.deleted) { state = emptyState(); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } }
      if (e.key === 'candidates') return queue(async () => { const c = await io.getDoc('candidates', candidates); if (c && Array.isArray(c.items)) candidates = c; });
      return chain;
    }
    if (e.type === 'plugin:job') return e.id === 'weekly' ? queue(weekly) : chain;
    if (!e.type.startsWith('thread:')) return chain;
    const next = collect(e, state, settings);
    if (next === state) return chain;
    state = next;
    saveSoon();
    if (e.type === 'thread:turn') return queue(runDetectors);
    return chain;
  }

  return {
    load,
    handle,
    flush,
    /** Read the budget from the daemon now (the worker's 15-minute timer). */
    refreshBudget: () => queue(() => readBudget(now())),
    /** Resolves when the queued work is done (tests, shutdown). */
    idle: () => Promise.all([chain, reviewsIdle()]),
    get state() { return state; },
  };
}
