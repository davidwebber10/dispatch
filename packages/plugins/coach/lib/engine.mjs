// The Coach worker's engine (coach spec section 8): it folds the daemon's events into the signals
// state, runs the detectors when a turn ends, and judges new candidates into cards. All I/O is
// injected (`io`), so the tests drive it against a fake daemon; worker/index.mjs is the real shell.
//
// io: { getDoc(key, fallback), putDoc(key, value), getSettings(), assist(req) → { result, budget, refused },
//       notify({ title, body, url }), now(), log(...) }
//
// Documents: `signals` (lib/signals.mjs), `candidates` ({ items, seen }), `cards` ({ items, judged }),
// `status` ({ budget, level, stepped, at }: what the daemon last said about the budget).
import { withDefaults } from './settings.mjs';
import { collect, emptyState } from './signals.mjs';
import { detect, proposeNew } from './detectors.mjs';
import { allows, normalizeMemory, emptyMemory } from './memory.mjs';
import { isMuted } from './cadence.mjs';
import { effectiveLevel } from './plan.mjs';
import { judgeCandidate, joinCards, unjudged } from './judge.mjs';

const SAVE_DELAY_MS = 5_000;
/** At most this many candidates are judged after one turn: each is a model call or two. */
export const JUDGE_PER_RUN = 3;
/** A candidate older than this is no longer "what you just did": it is not judged. */
export const FRESH_MS = 2 * 3600_000;

export function createEngine(io) {
  let settings = withDefaults(null);
  let state = emptyState();
  let candidates = { items: [], seen: [] };
  let memory = emptyMemory();
  let status = { budget: null, level: null, stepped: false, at: null, harness: null };
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
      await loadMemory();
    } catch (err) { log('load failed:', err.message); }
  }

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
    let budget = status.budget;
    let harness = status.harness;
    for (const c of fresh.slice(-JUDGE_PER_RUN).reverse()) {
      const r = await judgeCandidate(c, { settings, memory, budget, assist: io.assist, now: t, harness });
      budget = r.budget; harness = r.harness;
      results.push(r);
      if (r.outcome === 'budget') break;
    }
    const lvl = effectiveLevel(settings, budget);
    status = { budget, level: lvl.level, stepped: lvl.stepped, at, harness };
    await io.putDoc('status', status);
    if (results.some((r) => r.outcome !== 'budget')) {
      // Read again: the web part may have written the document (Reset) while the model answered.
      const latest = await io.getDoc('cards', cardsDoc);
      await io.putDoc('cards', joinCards(latest, results, at));
      for (const r of results) if (r.outcome === 'card') log(`card ${r.id}`);
    }
  }

  async function runDetectors() {
    const t = now();
    const found = detect(state, settings, t, { weakest: null }).filter((c) => allows(memory, c, t));
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

  function handle(e) {
    if (!e || typeof e.type !== 'string') return chain;
    if (e.type === 'plugin:settings') return queue(loadSettings);
    if (e.type === 'plugin:data') {
      if (e.key === 'memory') return queue(loadMemory);
      // Reset (What the Coach knows) drops the signals: follow it.
      if (e.key === 'signals' && e.deleted) { state = emptyState(); if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } }
      if (e.key === 'candidates') return queue(async () => { const c = await io.getDoc('candidates', candidates); if (c && Array.isArray(c.items)) candidates = c; });
      return chain;
    }
    if (e.type === 'plugin:job') return chain;
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
    /** Resolves when the queued work is done (tests, shutdown). */
    idle: () => chain,
    get state() { return state; },
  };
}
