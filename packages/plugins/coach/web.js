// Coach — a bundled Dispatch plugin (docs/superpowers/specs/2026-11-07-coach-design.md).
// It looks at how you work with AI and suggests one small next step at a natural break: a card
// under the message box, a tab in the right column, and its own screen. The worker
// (worker/index.mjs) watches the thread events and proposes candidates; this part shows cards,
// takes feedback, and keeps the memory you can see and edit. It never sends anything by itself.
//
// Documents it reads and writes: `cards` ({ items: card[] }, written by the judge), `cardState`
// ({ [cardId]: { state, at } }: shown, dismissed, used, down), `cadence` (lib/cadence.mjs), `memory`
// (lib/memory.mjs), `status` (the worker: the budget it last heard, and the harness it ran on). Reset also
// strips excerpts from `cards` and `candidates` and drops `signals`.
import { withDefaults, DEFAULT_THRESHOLDS } from './lib/settings.mjs';
import { mayShow, emptyCadence, noteShown, dismiss, mute, unmute, isMuted, mutedForever, inQuietHours, isStale, CARD_MAX_AGE_HOURS } from './lib/cadence.mjs';
import { planCall, LARGE_DEFAULT, liveBudget } from './lib/plan.mjs';
import { addGoal, setGoalStatus, editGoal, mapGoal, activeGoals, MAX_ACTIVE } from './lib/goals.mjs';
import { morePrompt, parseAnswer, partWords, buildPluginPrompt, cleanParts } from './lib/prompts.mjs';
import { chatContext, chatPrompt, parseChat, threadObservations, appendTurns } from './lib/chat.mjs';
import { REASONS, emptyMemory, normalizeMemory, applyFeedback, confirmFact, editFact, removeItem, allows, factsToReconfirm, dueForReview, reviewMuted, resetMemory, stripExcerpts, memoryItems, typeLabel } from './lib/memory.mjs';

/** The detector each threshold group tunes (Settings → Coach → Advanced). */
const DETECTOR_OF_THRESHOLD = { skillFit: 'skill-fit', pluginFit: 'plugin-fit', repeatedPrompt: 'repeated-prompt', serialIndependent: 'serial-independent', idleWait: 'idle-wait', stepByStep: 'step-by-step', noPlanBigTask: 'no-plan-big-task', fastApprove: 'fast-approve', narrowBreadth: 'narrow-breadth' };
const MEASURES = { ambition: 'AMBITION', delegation: 'DELEGATION', reuse: 'REUSE', judgment: 'JUDGMENT', breadth: 'BREADTH' };
const CLOSED = new Set(['dismissed', 'used', 'down']);
/** The Coach keeps at most this many review documents (review finding 7). */
const MAX_REVIEWS = 20;
const WELCOME = Object.freeze({
  id: 'welcome', type: 'welcome', measure: null, terminalId: null,
  headline: 'Get one small tip at a time',
  why: 'The Coach looks at the prompts you send and how your threads run. It remembers only what you tell it, and it stays on this machine.',
  action: { kind: 'settings', label: 'Choose how often' },
});

// ── styles: CSS variables only (the app has themes) ─────────────────────────────────────────
const S = {
  card: { position: 'relative', margin: '0 0 8px', padding: '12px 14px', borderRadius: 'var(--radius-xl)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', fontSize: 13, lineHeight: 1.45, color: 'var(--color-text-primary)' },
  x: { position: 'absolute', top: 8, right: 8, width: 24, height: 24, padding: 0, borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  kicker: { font: '600 10px var(--font-mono)', letterSpacing: 1, color: 'var(--color-accent)' },
  axis: { color: 'var(--color-text-tertiary)' },
  head: { fontWeight: 650, fontSize: 14.5, margin: '4px 28px 2px 0' },
  why: { color: 'var(--color-text-secondary)', fontSize: 13 },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' },
  btn: { height: 28, padding: '0 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12.5, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 },
  primary: { height: 28, padding: '0 11px', borderRadius: 'var(--radius-md)', border: 'none', background: 'var(--color-accent)', color: 'var(--color-on-accent)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
  icon: { width: 28, height: 28, padding: 0, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 },
  more: { marginTop: 10, borderTop: '1px solid var(--color-border)', paddingTop: 10, fontSize: 13, color: 'var(--color-text-secondary)' },
  ex: { background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', margin: '6px 0', fontSize: 12.5, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' },
  exLabel: { display: 'block', marginBottom: 2, font: '600 10px var(--font-mono)', letterSpacing: 1, color: 'var(--color-text-tertiary)' },
  menu: { position: 'absolute', right: 10, bottom: 44, zIndex: 2, width: 230, padding: 5, borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-modal)', color: 'var(--color-text-primary)' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', color: 'inherit', fontSize: 12.5, cursor: 'pointer' },
  sep: { height: 1, margin: '4px 0', background: 'var(--color-border)' },
  note: { marginTop: 8, fontSize: 12, color: 'var(--color-text-tertiary)' },
  banner: { margin: '0 0 8px', fontSize: 12.5, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 },
  link: { border: 'none', background: 'none', padding: 0, color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12.5 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { height: 26, padding: '0 10px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-border)', background: 'none', color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' },
  chipOn: { height: 26, padding: '0 10px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))', color: 'var(--color-accent)', fontSize: 12, cursor: 'pointer' },
  input: { marginTop: 8, width: '100%', height: 32, boxSizing: 'border-box', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 12.5, padding: '0 10px' },
  toast: { marginTop: 2, fontSize: 12.5, color: 'var(--color-text-secondary)', background: 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '7px 10px', marginRight: 28 },
  section: { padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' },
  label: { font: '600 10.5px var(--font-mono)', letterSpacing: 1, color: 'var(--color-text-tertiary)' },
  fact: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, padding: '7px 0', borderBottom: '1px solid var(--color-border)' },
  src: { color: 'var(--color-text-tertiary)', fontSize: 11 },
  bar: { display: 'inline-block', height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 'var(--radius-pill)' },
};
const fmtDate = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };

/** True while the person is writing: the composer has text and an editable element has focus. */
function typing(ctx) {
  if (!ctx.value || !String(ctx.value).trim()) return false;
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true);
}

export function createCoach(d, deps = {}) {
  const { h, hooks: { useState, useEffect }, storage, settings, events } = d;
  // The id the host gave this copy: a copy to local runs under its own id.
  const PLUGIN = d.id || 'coach';
  const VIEW_KEY = `plugin:${PLUGIN}:coach`;
  const now = deps.now || (() => new Date());
  // Icons come from the app's icon map (d.icons, Phosphor); never emoji. A missing icon falls back to a short word.
  const icon = (name, fallback, size = 15) => { const I = d.icons && d.icons[name]; return I ? h(I, { size, 'aria-hidden': true }) : fallback; };

  // "More": the detail behind a card, one large-model call on click (coach spec section 5, tier 3).
  // The tier comes from the plan: thoroughness, the budget the worker last heard, and the harness it
  // last ran on. At the cap nothing is called. An answer that is not whole shows nothing.
  async function defaultRequestMore(card) {
    if (typeof d.assist !== 'function') return null;
    const st = store.getState();
    const plan = planCall('more', st.settings, liveBudget(st.status.budget, now()), { harness: st.status.harness });
    if (plan.tier === 'none') return { budget: true };
    const r = await d.assist(PLUGIN, { ...morePrompt(card, st.memory), harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) });
    const j = parseAnswer(r && r.text);
    if (!j || typeof j.better !== 'string' || !j.better.trim()) return null;
    return { wrote: card.excerpt || '', better: j.better.trim(), bullets: Array.isArray(j.bullets) ? j.bullets.filter((b) => typeof b === 'string').slice(0, 4) : [] };
  }
  const requestMore = deps.requestMore || defaultRequestMore;

  // ── state: the plugin's documents, loaded once and kept current by plugin:data events ──
  const store = d.zustand.create(() => ({
    loaded: false,
    settings: withDefaults(null),
    cadence: emptyCadence(now()),
    cards: [],
    cardState: {},
    busy: {},       // terminalId → true between a prompt and its turn end
    more: {},       // cardId → { status: 'loading' | 'ok' | 'none', data }
    offer: null,    // { type, measure, terminalId }: a tip type the person dismissed 3 times; offer to turn it off
    memory: emptyMemory(),
    status: { budget: null, harness: null, level: null, stepped: false }, // the worker's last word on the budget
    toast: null,    // { terminalId, effect, undo, fact, saved, cardId, closed }: what the last feedback changed
    measures: null, // the worker's `measures` document: { scores, weakest, at }
    recap: null,    // the worker's weekly recap
    chat: { turns: [] }, // the chat history (spec section 4.9)
    chatDraft: null, // text for the chat box ("Tell me more about this")
    reviews: {},    // reviews:<id> → the review job document (spec section 4.10)
    reviewOpen: null, // the review the person asked for last
    signals: null,  // the worker's signals, loaded when the tab or the chat needs them
    signalsLoaded: false,
  }));

  async function load() {
    const [s, cadence, cards, cardState, memory, status, measuresDoc, recap, chat] = await Promise.all([
      settings.get(PLUGIN, null).catch(() => null),
      storage.get(PLUGIN, 'cadence', null).catch(() => null),
      storage.get(PLUGIN, 'cards', null).catch(() => null),
      storage.get(PLUGIN, 'cardState', null).catch(() => null),
      storage.get(PLUGIN, 'memory', null).catch(() => null),
      storage.get(PLUGIN, 'status', null).catch(() => null),
      storage.get(PLUGIN, 'measures', null).catch(() => null),
      storage.get(PLUGIN, 'recap', null).catch(() => null),
      storage.get(PLUGIN, 'chat', null).catch(() => null),
    ]);
    const firstRun = !cadence || !cadence.firstSeenAt;
    const cad = firstRun ? { ...emptyCadence(now()), ...(cadence || {}), firstSeenAt: now().toISOString() } : cadence;
    store.setState({ loaded: true, settings: withDefaults(s), cadence: cad, cards: (cards && Array.isArray(cards.items)) ? cards.items : [], cardState: cardState || {}, memory: normalizeMemory(memory), status: { ...store.getState().status, ...(status || {}) }, measures: measuresDoc, recap, chat: chat && Array.isArray(chat.turns) ? chat : { turns: [] } });
    if (store.getState().signalsLoaded) void ensureSignals(true);
    void loadReviews();
    if (firstRun) await storage.set(PLUGIN, 'cadence', cad).catch(() => {});
    // A new recap the worker may announce (not written in a mute or quiet hours) dots the Coach view until seen.
    const unseen = !!(recap && recap.announce && recap.at && cad.recapSeen !== recap.at);
    if (d.actions && typeof d.actions.setBadge === 'function') d.actions.setBadge(VIEW_KEY, unseen ? 1 : 0);
  }
  async function markRecapSeen() {
    const r = store.getState().recap;
    if (!r || !r.at || store.getState().cadence.recapSeen === r.at) return;
    await saveCadence({ ...store.getState().cadence, recapSeen: r.at });
    if (d.actions && typeof d.actions.setBadge === 'function') d.actions.setBadge(VIEW_KEY, 0);
  }
  // The budget is the daemon's (a hard stop it enforces, spec section 7.4). Its default comes from
  // plugin.json, so it holds before this part loads; the web part writes it only when the person
  // changes it (an owner's "no cap" is never undone here).
  const ready = load();
  events.on(['plugin:data', 'plugin:settings'], (e) => { if (e.id === PLUGIN) void load(); });
  events.on('thread:prompt', (e) => { if (e.terminalId) store.setState({ busy: { ...store.getState().busy, [e.terminalId]: true } }); });
  events.on('thread:turn', (e) => { if (e.terminalId) store.setState({ busy: { ...store.getState().busy, [e.terminalId]: false } }); });

  async function saveCadence(next) { store.setState({ cadence: next }); await storage.set(PLUGIN, 'cadence', next); }
  async function setCardState(id, state) {
    const next = { ...store.getState().cardState, [id]: { state, at: now().toISOString() } };
    store.setState({ cardState: next });
    await storage.set(PLUGIN, 'cardState', next);
  }
  async function saveMemory(next) { store.setState({ memory: next }); await storage.set(PLUGIN, 'memory', next); }
  const muteAs = (how) => saveCadence(mute(store.getState().cadence, how, now()));
  const doUnmute = () => saveCadence(unmute(store.getState().cadence));

  async function markShown(card) {
    // The worker makes no model call until the person has seen the welcome card (review finding 5).
    if (card.id === WELCOME.id) { if (!store.getState().cadence.welcomeSeenAt) await saveCadence({ ...store.getState().cadence, welcomeSeenAt: now().toISOString() }); return; }
    await saveCadence(noteShown(store.getState().cadence, now()));
    await setCardState(card.id, 'shown');
  }
  async function onDismiss(card) {
    if (card.id === WELCOME.id) { await saveCadence({ ...store.getState().cadence, welcomeDone: true }); return; }
    const r = dismiss(store.getState().cadence, card.type, now());
    if (r.offerTurnOff) store.setState({ offer: { type: card.type, measure: card.measure, terminalId: card.terminalId } });
    await saveCadence(r.state);
    await setCardState(card.id, 'dismissed');
  }
  async function loadMore(card) {
    const cur = store.getState().more[card.id];
    if (cur && cur.status !== 'none') return;
    const put = (v) => store.setState({ more: { ...store.getState().more, [card.id]: v } });
    if (card.more && card.more.better) { put({ status: 'ok', data: card.more }); return; }
    put({ status: 'loading' });
    let data = null;
    try { data = await requestMore(card); } catch (err) { console.warn('[coach] more failed:', err && err.message ? err.message : err); }
    put(data && data.better ? { status: 'ok', data } : { status: data && data.budget ? 'budget' : 'none' });
  }
  function tryIt(card, ctx, text) {
    const a = card.action || {};
    const acts = d.actions || {};
    const projectId = card.projectId || ctx.sessionId || undefined;
    // A skill (spec section 4.8): the review sheet writes it only on its Create; Cancel keeps the card.
    if (a.kind === 'skill' && card.skill && typeof acts.createSkill === 'function') {
      void acts.createSkill({ name: card.skill.name, description: card.skill.description, body: card.skill.body, projectId }).then((r) => {
        if (!r) return;
        void setCardState(card.id, 'used');
        if (typeof d.hint === 'function') d.hint('Skill created. Every thread gets it now.');
      }).catch(() => {});
      return;
    }
    if (a.kind === 'skill' && card.skill) { ctx.set(card.skill.body); void setCardState(card.id, 'used'); return; }
    if (text) ctx.set(text);
    else if (a.kind === 'schedule' && typeof acts.openSchedule === 'function') acts.openSchedule({ projectId, prompt: a.prompt, cron: a.cron, label: a.label });
    else if (a.kind === 'threads' && typeof acts.openNewThreads === 'function') acts.openNewThreads({ projectId, prompts: a.prompts || [] });
    // A plugin to build (spec section 4.7): a new thread whose first prompt asks an agent to build it; the person confirms.
    else if (a.kind === 'plugin' && typeof acts.openNewThreads === 'function') acts.openNewThreads({ projectId, prompts: [a.prompt] });
    else if (a.kind === 'settings') { if (typeof acts.openSettings === 'function') acts.openSettings(`plugin:${PLUGIN}:coach`); }
    else {
      // Without the dialog (or for a prompt tip), the composer gets the text: the person sends it, or not.
      const fill = a.text || a.prompt || (Array.isArray(a.prompts) ? a.prompts.join('\n\n') : '');
      if (fill) ctx.set(fill);
    }
    if (card.id === WELCOME.id) void saveCadence({ ...store.getState().cadence, welcomeDone: true });
    else void setCardState(card.id, 'used');
  }

  /** Turn the Coach off (the welcome card): the plugin is disabled, as on the Plugins page. */
  async function turnOff() {
    await saveCadence({ ...store.getState().cadence, welcomeDone: true }).catch(() => {});
    const api = d.api || {};
    if (typeof api.disablePlugin === 'function') await api.disablePlugin(PLUGIN).catch(() => {});
    else if (d.actions && typeof d.actions.openSettings === 'function') d.actions.openSettings('plugins');
  }

  /** Feedback on a card: one exact effect, said in one line with Undo (coach spec section 4.4). */
  async function giveFeedback(card, reason, text, terminalId) {
    const r = applyFeedback(store.getState().memory, { cardType: card.type, measure: card.measure, reason, text, headline: card.headline, situation: card.id || undefined }, now());
    store.setState({ toast: { terminalId, effect: r.effect, undo: r.undo, fact: r.proposedFact || null, saved: null, cardId: card.id, closed: reason !== 'up' } });
    if (r.rest) {
      await saveCadence(dismiss(store.getState().cadence, card.type, now()).state);
      if (card.id) await setCardState(card.id, 'dismissed');
      return;
    }
    await saveMemory(r.memory);
    if (reason !== 'up' && card.id) await setCardState(card.id, 'down');
  }
  async function decideFact(save) {
    const t = store.getState().toast;
    if (!t || !t.fact) return;
    if (save) await saveMemory(confirmFact(store.getState().memory, t.fact, now()));
    store.setState({ toast: { ...t, fact: null, saved: save ? t.fact.text : null } });
  }
  async function undoFeedback() {
    const t = store.getState().toast;
    if (!t) return;
    store.setState({ toast: null });
    await saveMemory(t.undo);
    if (t.closed && t.cardId) await setCardState(t.cardId, 'shown');
  }

  /** The card for this thread now, and whether it is new (not shown before). */
  function pick(st, terminalId, phone) {
    const t = now();
    if (mayShow(st.cadence, st.settings, t, 'card', { welcome: true, phone })) return { card: WELCOME, fresh: !st.cadence.welcomeSeenAt };
    const live = st.settings.howOften !== 'off' && st.settings.howOften !== 'quiet' && !inQuietHours(st.settings.quietHours, t) && !(phone && !st.settings.phone);
    // Newest first; a card that serves an active goal comes before the rest (spec section 4.6).
    const goals = new Set(activeGoals(st.memory).map((g) => g.id));
    const order = [...st.cards].reverse();
    order.sort((a, b) => Number(!!(b.goal && goals.has(b.goal))) - Number(!!(a.goal && goals.has(a.goal))));
    for (const c of order) {
      if (c.terminalId && c.terminalId !== terminalId) continue;
      // A card about something long past is not "what you just did" (default 48 hours; Advanced).
      if (isStale(c, st.settings, t)) continue;
      const cs = st.cardState[c.id];
      if (cs && CLOSED.has(cs.state)) continue;
      if (!allows(st.memory, c, t)) continue;
      if (cs && cs.state === 'shown') { if (live) return { card: c, fresh: false }; continue; }
      if (mayShow(st.cadence, st.settings, t, 'card', { type: c.type, phone })) return { card: c, fresh: true };
    }
    return null;
  }

  // ── the card under the message box ───────────────────────────────────────────────────────
  function MutedBanner({ cadence }) {
    const until = new Date(cadence.mutedUntil);
    const label = mutedForever(cadence) ? 'Coach muted until you turn it on' : `Coach muted until ${until.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    return h('div', { 'data-testid': 'coach-muted', role: 'status', style: S.banner },
      icon('bell-slash', null, 14),
      h('span', null, label), h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', style: S.link, onClick: () => { void doUnmute(); } }, 'Unmute'));
  }

  function Toast({ toast }) {
    const goKnows = () => { if (d.actions && typeof d.actions.setView === 'function') d.actions.setView(`plugin:${PLUGIN}:coach`); };
    return h('div', { role: 'status', 'data-testid': 'coach-toast', style: S.card },
      h('button', { type: 'button', 'aria-label': 'Close', title: 'Close', style: S.x, onClick: () => store.setState({ toast: null }) }, icon('x', 'Close', 14)),
      h('div', { style: S.kicker }, 'COACH'),
      toast.fact
        ? h('div', { style: S.toast },
          'Save this to what the Coach knows? ', h('b', null, `"${toast.fact.text}"`),
          h('div', { style: { ...S.row, marginTop: 6 } },
            h('button', { type: 'button', style: S.primary, onClick: () => { void decideFact(true); } }, 'Save'),
            h('button', { type: 'button', style: S.btn, onClick: () => { void decideFact(false); } }, "Don't save")))
        : h('div', { style: S.toast },
          toast.effect,
          toast.saved ? [' I saved: ', h('b', { key: 'f' }, `"${toast.saved}"`)] : null,
          toast.saved && h('button', { type: 'button', style: { ...S.link, marginLeft: 8 }, onClick: goKnows }, 'Edit'),
          h('button', { type: 'button', style: { ...S.link, marginLeft: 8 }, onClick: () => { void undoFeedback(); } }, 'Undo')));
  }

  function Offer({ offer }) {
    return h('div', { role: 'note', 'data-testid': 'coach-offer', style: S.card },
      h('div', { style: S.kicker }, 'COACH'),
      h('div', { style: S.why }, `You dismissed "${typeLabel(offer.type)}" tips 3 times. Turn off this type?`),
      h('div', { style: S.row },
        h('button', { type: 'button', style: S.primary, onClick: () => { store.setState({ offer: null }); void giveFeedback({ type: offer.type, measure: offer.measure, headline: typeLabel(offer.type), id: null }, 'off', '', offer.terminalId); } }, 'Turn off'),
        h('button', { type: 'button', style: S.btn, onClick: () => store.setState({ offer: null }) }, 'Keep')));
  }

  function FeedbackForm({ card, ctx, onCancel }) {
    const [reason, setReason] = useState(null);
    const [text, setText] = useState('');
    return h('div', { style: S.more },
      h('div', { style: S.chips }, ...Object.entries(REASONS).map(([key, label]) =>
        h('button', { key, type: 'button', 'aria-pressed': reason === key, style: reason === key ? S.chipOn : S.chip, onClick: () => setReason(reason === key ? null : key) }, label))),
      h('input', { type: 'text', 'aria-label': 'Why? (optional)', placeholder: 'Why? (optional)', value: text, style: S.input, onChange: (e) => setText(e.target.value) }),
      h('div', { style: S.row },
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', style: S.btn, onClick: onCancel }, 'Cancel'),
        h('button', { type: 'button', style: S.primary, onClick: () => { void giveFeedback(card, reason || 'down', text, ctx.terminalId); } }, 'Send')));
  }

  function CardView({ card, ctx, fresh }) {
    const [fb, setFb] = useState(false);
    const [open, setOpen] = useState(false);
    const [menu, setMenu] = useState(false);
    const [why, setWhy] = useState(false);
    const more = store((s) => s.more[card.id]);
    useEffect(() => { if (fresh) void markShown(card); }, []);
    const welcome = card.id === WELCOME.id;
    const better = open && more && more.status === 'ok' ? more.data.better : null;
    const menuItem = (label, run) => h('button', { key: label, type: 'button', role: 'menuitem', style: S.menuItem, onClick: () => { setMenu(false); run(); } }, label);
    return h('div', { role: 'note', 'aria-label': 'Coach tip', 'data-testid': 'coach-card', style: S.card },
      h('button', { type: 'button', 'aria-label': 'Dismiss (not now)', title: 'Dismiss (not now)', style: S.x, onClick: () => { void onDismiss(card); } }, icon('x', 'Close', 14)),
      h('div', { style: S.kicker }, 'COACH', card.measure && MEASURES[card.measure] ? h('span', { style: S.axis }, ` · ${MEASURES[card.measure]}`) : null),
      h('div', { style: S.head }, card.headline),
      h('div', { style: S.why }, card.why),
      card.skill && h('div', { style: { ...S.note, color: 'var(--color-text-secondary)' } }, `The skill: ${card.skill.name}. ${card.skill.description}`),
      card.plugin && h('div', { style: { ...S.note, color: 'var(--color-text-secondary)' } }, `The plugin: ${card.plugin}${Array.isArray(card.parts) && card.parts.length ? ` Parts: ${partWords(card.parts)}.` : ''}`),
      open && h('div', { style: S.more },
        (!more || more.status === 'loading') && h('div', { style: S.note }, 'Getting more detail…'),
        more && more.status === 'none' && h('div', { style: S.note }, 'The Coach could not get more detail just now.'),
        more && more.status === 'budget' && h('div', { style: S.note }, 'The Coach has used its budget for this week. More detail comes back when the week resets.'),
        more && more.status === 'ok' && [
          (more.data.wrote || card.excerpt) && h('div', { key: 'w', style: S.ex }, h('b', { style: S.exLabel }, 'YOU WROTE'), more.data.wrote || card.excerpt),
          h('div', { key: 't', style: S.ex }, h('b', { style: S.exLabel }, 'TRY'), more.data.better),
          (more.data.bullets || []).length > 0 && h('ul', { key: 'b', style: { margin: '4px 0 0', paddingLeft: 18 } }, ...more.data.bullets.map((b, i) => h('li', { key: i, style: { margin: '3px 0' } }, b))),
        ]),
      why && h('div', { style: S.note }, card.reason || 'The Coach saw this in your recent threads.'),
      fb && h(FeedbackForm, { card, ctx, onCancel: () => setFb(false) }),
      h('div', { style: S.row },
        h('button', { type: 'button', style: S.primary, onClick: () => tryIt(card, ctx, better) }, better ? 'Use this prompt' : (card.action && card.action.label) || 'Try it'),
        !welcome && h('button', { type: 'button', style: S.btn, onClick: () => { if (open) setOpen(false); else { setOpen(true); void loadMore(card); } } }, open ? 'Less' : 'More'),
        // On by default (owner, 2026-11-07): the welcome card is where the person can say no.
        welcome && h('button', { type: 'button', style: S.btn, onClick: () => { void turnOff(); } }, 'Turn off'),
        h('span', { style: { flex: 1 } }),
        !welcome && h('button', { type: 'button', 'aria-label': 'Helpful', title: 'Helpful', style: S.icon, onClick: () => { void giveFeedback(card, 'up', '', ctx.terminalId); } }, icon('thumbs-up', 'Yes')),
        !welcome && h('button', { type: 'button', 'aria-label': 'Not helpful', title: 'Not helpful', 'aria-expanded': fb, style: S.icon, onClick: () => setFb(!fb) }, icon('thumbs-down', 'No')),
        !welcome && h('button', { type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': menu, style: S.icon, onClick: () => setMenu(!menu) }, icon('dots', '...', 16))),
      menu && h('div', { role: 'menu', style: S.menu },
        menuItem('Mute for 1 hour', () => { void muteAs('hour'); }),
        menuItem('Mute for today', () => { void muteAs('today'); }),
        menuItem('Mute until I turn it on', () => { void muteAs('on'); }),
        h('div', { key: 's1', style: S.sep }),
        menuItem('Fewer tips like this', () => { void giveFeedback(card, 'fewer', '', ctx.terminalId); }),
        menuItem('Turn off this type', () => { void giveFeedback(card, 'off', '', ctx.terminalId); }),
        h('div', { key: 's2', style: S.sep }),
        menuItem('Tell me more about this', () => { store.setState({ chatDraft: `Tell me more about this tip: "${card.headline}"` }); if (ctx.surface !== 'inspector' && d.actions && typeof d.actions.setView === 'function') d.actions.setView(VIEW_KEY); }),
        menuItem('Why am I seeing this?', () => setWhy(true)),
        menuItem('What the Coach knows', () => { if (d.actions && typeof d.actions.setView === 'function') d.actions.setView(`plugin:${PLUGIN}:coach`); })));
  }

  function Card(ctx) {
    const st = store((s) => s);
    const phone = d.hooks.useIsMobile ? !!d.hooks.useIsMobile() : false;
    if (!st.loaded || !ctx.terminalId || (ctx.surface !== 'thread' && ctx.surface !== 'terminal')) return null;
    if (st.toast && st.toast.terminalId === ctx.terminalId) return h(Toast, { toast: st.toast });
    if (isMuted(st.cadence, now())) return h(MutedBanner, { cadence: st.cadence });
    if (st.busy[ctx.terminalId] || typing(ctx)) return null;
    if (st.offer && (!st.offer.terminalId || st.offer.terminalId === ctx.terminalId)) return h(Offer, { offer: st.offer });
    const picked = pick(st, ctx.terminalId, phone);
    if (!picked) return null;
    return h(CardView, { key: picked.card.id, card: picked.card, ctx, fresh: picked.fresh });
  }

  // ── What the Coach knows: every item, with its source and date, Edit and Delete; Pause and Reset ──
  async function resetAll() {
    await saveMemory(resetMemory());
    for (const key of ['cards', 'candidates']) {
      const doc = await storage.get(PLUGIN, key, null).catch(() => null);
      if (doc) await storage.set(PLUGIN, key, stripExcerpts(doc));
    }
    await storage.remove(PLUGIN, 'signals').catch(() => {});
    // The chat and every review (their quotes are the person's words) go too.
    await storage.remove(PLUGIN, 'chat').catch(() => {});
    for (const key of await reviewKeys()) await storage.remove(PLUGIN, key).catch(() => {});
    store.setState({ chat: { turns: [] }, reviews: {}, reviewOpen: null, signals: null, cards: stripExcerpts({ items: store.getState().cards }).items, toast: null, offer: null });
  }

  function Knows() {
    const memory = store((s) => s.memory);
    const cadence = store((s) => s.cadence);
    const [editing, setEditing] = useState(null); // { id, text }
    const [confirmReset, setConfirmReset] = useState(false);
    const t = now();
    const items = memoryItems(memory);
    const stale = new Set(factsToReconfirm(memory, t).map((f) => f.id));
    const reviews = dueForReview(memory, t);
    const btn = (label, onClick, aria, primary) => h('button', { key: aria || label, type: 'button', 'aria-label': aria || label, style: primary ? S.primary : S.btn, onClick }, label);
    const paused = mutedForever(cadence) && isMuted(cadence, t);
    const box = { ...S.toast, marginRight: 0, marginTop: 10 };
    return h('div', { style: S.section },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: S.label }, 'WHAT THE COACH KNOWS'), h('span', { style: { flex: 1 } }),
        paused ? btn('Resume', () => { void doUnmute(); }) : btn('Pause', () => { void muteAs('on'); }),
        btn('Reset', () => setConfirmReset(true))),
      confirmReset && h('div', { style: box },
        'Reset clears everything the Coach knows, and the excerpts of what you wrote in its card history.',
        h('div', { style: { ...S.row, marginTop: 6 } },
          btn('Yes, reset', () => { setConfirmReset(false); void resetAll(); }, null, true),
          btn('Cancel', () => setConfirmReset(false)))),
      ...reviews.map((x) => h('div', { key: `r-${x.type}`, 'data-testid': 'coach-review', style: box },
        `You turned off "${typeLabel(x.type)}" in ${new Date(x.at).toLocaleString('en-US', { month: 'long' })}. Show these again?`,
        h('div', { style: { ...S.row, marginTop: 6 } },
          btn('Show again', () => { void saveMemory(reviewMuted(store.getState().memory, x.type, true, now())); }, null, true),
          btn('Keep off', () => { void saveMemory(reviewMuted(store.getState().memory, x.type, false, now())); })))),
      items.length === 0
        ? h('div', { style: { ...S.note, fontSize: 13 } }, 'The Coach knows nothing about you yet.')
        : h('div', { 'data-testid': 'coach-knows', style: { marginTop: 6 } }, ...items.map((i) => {
          const key = `${i.kind}:${i.key}`;
          if (editing && editing.id === i.key && (i.kind === 'fact' || i.kind === 'goal')) {
            return h('div', { key, style: S.fact },
              h('input', { type: 'text', 'aria-label': 'Fact', value: editing.text, style: { ...S.input, marginTop: 0, flex: 1 }, onChange: (e) => setEditing({ id: i.key, text: e.target.value }) }),
              btn('Save', () => { if (i.kind === 'goal') void changeGoal(i.key, editing.text); else void saveMemory(editFact(store.getState().memory, i.key, editing.text, now())); setEditing(null); }, null, true),
              btn('Cancel', () => setEditing(null)));
          }
          return h('div', { key, style: S.fact },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { color: 'var(--color-text-primary)' } }, i.label),
              h('div', { style: S.src }, [i.source, fmtDate(i.at)].filter(Boolean).join(' · ')),
              stale.has(i.key) && i.kind === 'fact' && h('div', { style: { ...S.row, marginTop: 4 } },
                h('span', { style: S.note }, 'Still true?'),
                btn('Yes', () => { const f = store.getState().memory.facts.find((x) => x.id === i.key); if (f) void saveMemory(confirmFact(store.getState().memory, f, now())); }, 'Yes, still true'))),
            (i.kind === 'fact' || i.kind === 'goal') && btn('Edit', () => setEditing({ id: i.key, text: i.kind === 'goal' ? (store.getState().memory.goals.find((g) => g.id === i.key) || {}).text || '' : i.label }), `Edit ${i.label}`),
            btn('Delete', () => { void saveMemory(removeItem(store.getState().memory, i.kind, i.key)); }, `Delete ${i.label}`));
        })));
  }

  // ── the five measures (coach spec section 3; mockup part 4) ──────────────────────────────
  const MEASURE_LABEL = { ambition: 'Ambition', delegation: 'Delegation', reuse: 'Reuse', judgment: 'Judgment', breadth: 'Breadth' };
  const TREND = { 1: ['arrow-up', 'up'], 0: ['arrow-right', 'steady'], '-1': ['arrow-down', 'down'] };
  function Measures() {
    const doc = store((s) => s.measures);
    const scores = doc && doc.scores;
    return h('div', { 'data-testid': 'coach-measures', style: S.section },
      h('div', { style: S.label }, 'YOUR FIVE MEASURES · 30 DAYS'),
      !scores
        ? h('div', { style: { ...S.note, fontSize: 12.5 } }, 'The Coach shows your measures after a few days of work.')
        : h('div', { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 } }, ...Object.keys(MEASURE_LABEL).map((id) => {
          const m = scores[id] || { score: 0, trend: 0, enough: false };
          const [ico, word] = TREND[String(m.trend)] || TREND[0];
          const focus = doc.weakest === id;
          return h('div', { key: id, 'data-testid': `measure-${id}`, style: { display: 'grid', gridTemplateColumns: '84px 1fr 70px', alignItems: 'center', gap: 8, fontSize: 12.5 } },
            h('span', { style: { color: 'var(--color-text-primary)' } }, MEASURE_LABEL[id]),
            m.enough
              ? h('div', { style: S.bar }, h('div', { style: { ...S.barFill, width: `${Math.max(2, Math.min(100, m.score))}%`, background: focus ? 'var(--color-accent)' : 'var(--color-text-tertiary)' } }))
              : h('span', { style: S.src }, 'Not enough data yet'),
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, color: focus ? 'var(--color-accent)' : 'var(--color-text-tertiary)', fontSize: 11.5 } },
              m.enough ? h('span', { role: 'img', 'aria-label': `${MEASURE_LABEL[id]}: ${word}`, title: word, style: { display: 'inline-flex' } }, icon(ico, word, 13)) : null,
              focus ? 'focus' : null));
        })),
      h('div', { style: { ...S.note, fontSize: 11.5 } }, 'Bars compare you with your own past, never with other people.'));
  }

  // ── the right-column tab: the open thread's card, and the measures (spec section 4.2) ─────
  // "Review this thread" and the other review entry points (spec section 4.10): the review panel
  // on the Coach screen shows the estimate first; nothing runs until its Start.
  function ReviewButton({ scope, label }) {
    return h('button', { type: 'button', style: S.btn, onClick: () => { void requestReview(scope); } }, label);
  }
  async function reviewKeys() {
    const list = await storage.list(PLUGIN).catch(() => []);
    return (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x && x.key)).filter((k) => typeof k === 'string' && k.startsWith('reviews:'));
  }
  async function loadReviews() {
    const keys = await reviewKeys();
    const docs = await Promise.all(keys.map((k) => storage.get(PLUGIN, k, null).catch(() => null)));
    const reviews = {};
    keys.forEach((k, i) => { if (docs[i]) reviews[k] = docs[i]; });
    store.setState({ reviews });
  }
  /** Ask for a review: the worker works out the estimate first; nothing runs until Start. */
  async function requestReview(scope, opts = {}) {
    const id = `r${now().getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const key = `reviews:${id}`;
    const doc = { id, scope, state: 'planning', at: now().toISOString(), ...(opts.backfill ? { backfill: true } : {}) };
    store.setState({ reviews: { ...store.getState().reviews, [key]: doc }, reviewOpen: key });
    await storage.set(PLUGIN, key, doc);
    await pruneReviews(key);
    return key;
  }
  /** At most MAX_REVIEWS review documents: the oldest go first; one still running is kept. */
  async function pruneReviews(keep) {
    const keys = await reviewKeys();
    if (keys.length <= MAX_REVIEWS) return;
    const docs = await Promise.all(keys.map(async (k) => ({ k, doc: store.getState().reviews[k] || (await storage.get(PLUGIN, k, null).catch(() => null)) })));
    const busy = new Set(['planning', 'queued', 'reading', 'writing']);
    const old = docs.filter((x) => x.k !== keep && !(x.doc && busy.has(x.doc.state)))
      .sort((a, b) => String((a.doc && a.doc.at) || '').localeCompare(String((b.doc && b.doc.at) || '')));
    const drop = old.slice(0, keys.length - MAX_REVIEWS).map((x) => x.k);
    for (const k of drop) await storage.remove(PLUGIN, k).catch(() => {});
    if (drop.length) { const next = { ...store.getState().reviews }; for (const k of drop) delete next[k]; store.setState({ reviews: next }); }
  }
  async function patchReview(key, patch) {
    const cur = store.getState().reviews[key] || (await storage.get(PLUGIN, key, null)) || {};
    const next = { ...cur, ...patch };
    store.setState({ reviews: { ...store.getState().reviews, [key]: next } });
    await storage.set(PLUGIN, key, next);
  }
  const lastDays = (n) => ({ kind: 'range', from: new Date(now().getTime() - n * 86400_000).toISOString(), to: now().toISOString() });
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const FINDING_WORD = { 'went-well': 'Went well', handoff: 'Hand off more', plan: 'Plan first', check: 'Check the result', reuse: 'Reuse', parallel: 'Run in parallel' };

  /** The review the person asked for (or the newest one): the estimate with Start, the progress, the report. */
  function ReviewPanel({ terminalId = null }) {
    const reviews = store((s) => s.reviews);
    const open = store((s) => s.reviewOpen);
    let key = open && reviews[open] ? open : null;
    if (!key) {
      const list = Object.entries(reviews).filter(([, r]) => !terminalId || (r.scope && r.scope.kind === 'thread' && (r.scope.ids || []).includes(terminalId)));
      list.sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || '')));
      key = list.length ? list[0][0] : null;
    }
    if (terminalId && key && !(reviews[key].scope && (reviews[key].scope.ids || []).includes(terminalId))) key = null;
    if (!key) return null;
    const r = reviews[key];
    const plan = r.plan || {};
    const n = (plan.threads || []).length;
    let body;
    // Start waits while the estimate passes the budget, or while the cost is unknown and a smaller scope exists.
    const blocked = plan.fits === false || n === 0 || !!(plan.costUnknown && plan.smallerScope);
    if (r.state === 'planning') body = h('div', { style: S.note }, 'Working out what this review costs…');
    else if (r.state === 'estimate') {
      body = h('div', null,
        n === 0 ? h('div', null, 'There is nothing the Coach can read in this scope.')
          : plan.costUnknown ? h('div', null, `This review reads ${plural(n, 'thread', 'threads')} (${plural(plan.chunks || 0, 'part', 'parts')}). Cost unknown: the Coach has no usage figures for this account yet.`)
            : h('div', null, `This review reads ${plural(n, 'thread', 'threads')} (${plural(plan.chunks || 0, 'part', 'parts')}): about ${plan.estPercent}% of your weekly limit, an estimate.`),
        plan.fits === false && h('div', { style: { ...S.note, color: 'var(--color-text-secondary)' } }, 'That is more than the budget has left this week.'),
        plan.costUnknown && plan.smallerScope && h('div', { style: { ...S.note, color: 'var(--color-text-secondary)' } }, 'Start with a smaller scope while the cost is unknown.'),
        h('div', { style: S.row },
          h('button', { type: 'button', style: { ...S.primary, opacity: blocked ? 0.5 : 1 }, disabled: blocked, onClick: () => { void patchReview(key, { state: 'queued', startedAt: now().toISOString() }); } }, 'Start'),
          (plan.fits === false || plan.costUnknown) && plan.smallerScope && h('button', { type: 'button', style: S.btn, onClick: () => { void requestReview(plan.smallerScope, r.backfill ? { backfill: true } : {}); } }, `Review the newest ${plural(plan.smallerScope.ids.length, 'thread', 'threads')} instead`),
          h('button', { type: 'button', style: S.btn, onClick: () => { void patchReview(key, { state: 'cancelled', cancel: true }); } }, 'Cancel')));
    } else if (r.state === 'queued' || r.state === 'reading') {
      const p = r.progress || { done: 0, total: n };
      body = h('div', null, h('div', null, r.state === 'queued' ? 'Starting the review…' : `Reading ${p.done} of ${plural(p.total, 'thread', 'threads')}…`),
        h('div', { style: S.row }, h('button', { type: 'button', style: S.btn, onClick: () => { void patchReview(key, { state: 'cancelled', cancel: true }); } }, 'Cancel review')));
    } else if (r.state === 'writing') body = h('div', null, 'Writing the report…');
    else if (r.state === 'cancelled') body = h('div', { style: S.note }, 'The review was cancelled. Nothing more was read.');
    else if (r.state === 'failed') {
      body = h('div', null, h('div', { style: S.note }, r.error || 'The review stopped.'),
        // A review the restart stopped: a new estimate first, then Start, as before.
        r.restartable && h('div', { style: S.row }, h('button', { type: 'button', style: S.btn, onClick: () => { void patchReview(key, { state: 'planning', error: null, restartable: false, progress: null, cancel: false }); } }, 'Run again')));
    }
    else if (r.state === 'done' && r.report) {
      const rep = r.report;
      body = h('div', null,
        h('div', { style: { color: 'var(--color-text-secondary)' } }, rep.summary),
        (rep.findings || []).length > 0 && h('ul', { style: { margin: '8px 0 0', paddingLeft: 18 } }, ...rep.findings.map((f, i) => h('li', { key: i, style: { margin: '6px 0' } },
          h('div', { style: S.src }, FINDING_WORD[f.kind] || f.kind),
          h('div', { style: { ...S.ex, margin: '3px 0' } }, `"${f.quote}"`),
          h('div', null, f.note)))),
        (rep.nextSteps || []).length > 0 && h('div', { style: { marginTop: 8 } }, h('div', { style: S.src }, 'NEXT STEPS'),
          ...rep.nextSteps.map((s, i) => h('div', { key: i, style: { ...S.row, marginTop: 4 } }, h('span', { style: { flex: 1 } }, s.text), s.action && h('button', { type: 'button', style: S.btn, onClick: () => { void runAction(s.action); } }, actionLabel(s.action))))));
    } else body = null;
    const title = r.backfill ? 'LOOK BACK' : r.scope && r.scope.kind === 'thread' ? 'REVIEW OF THIS THREAD' : r.scope && r.scope.kind === 'project' ? 'REVIEW OF THIS PROJECT' : 'REVIEW';
    return h('div', { 'data-testid': 'coach-review', style: { ...S.section, fontSize: 13 } }, h('div', { style: { ...S.label, marginBottom: 6 } }, title), body);
  }

  /** The look back at history (spec section 4.10): offered once on the Coach screen; the estimate comes first. */
  function LookBack() {
    const cadence = store((s) => s.cadence);
    if (cadence.lookbackAnswered) return null;
    const answer = () => saveCadence({ ...store.getState().cadence, lookbackAnswered: true });
    return h('div', { 'data-testid': 'coach-lookback', style: S.section },
      h('div', { style: { fontWeight: 650 } }, 'Look back at your last 30 days'),
      h('div', { style: { ...S.why, marginTop: 4 } }, 'The Coach can read your threads from the last 30 days to build its first picture, so it is useful today instead of after a week. You see the cost first.'),
      h('div', { style: S.row },
        h('button', { type: 'button', style: S.primary, onClick: () => { void answer(); void requestReview(lastDays(30), { backfill: true }); } }, 'See the cost'),
        h('button', { type: 'button', style: S.btn, onClick: () => { void answer(); } }, 'Not now')));
  }

  // ── the right-column tab: about the open thread (owner, 2026-11-07; spec section 4.2) ──────
  // This thread's cards, what the Coach sees in it, the goals it touches, Review this thread, and
  // the chat about this thread. The five measure bars live on the Coach screen, not here.
  function CoachTab({ terminalId, sessionId }) {
    const st = store((s) => s);
    useEffect(() => { void ensureSignals(); }, []);
    if (!st.loaded) return null;
    if (!terminalId) {
      return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { style: { ...S.note, fontSize: 13 } }, 'Open a thread to see what the Coach sees in it.'),
        h('div', null, h('button', { type: 'button', style: S.btn, onClick: () => { if (d.actions && typeof d.actions.setView === 'function') d.actions.setView(VIEW_KEY); } }, 'Open the Coach screen')));
    }
    const t = now();
    const mine = [...st.cards].reverse().filter((c) => c.terminalId === terminalId && !(st.cardState[c.id] && CLOSED.has(st.cardState[c.id].state)) && allows(st.memory, c, t)).slice(0, 3);
    // The tab has no message box: a prompt is copied for the person to paste. The tab works during a
    // mute and never counts toward the daily cap (mockup part 7).
    const ctx = { surface: 'inspector', terminalId, sessionId, value: '', set: (text) => { if (typeof d.copyText === 'function') void d.copyText(text); if (typeof d.hint === 'function') d.hint('Copied. Paste it into the message box.'); }, insert: () => {} };
    let cardsBlock;
    if (st.toast && st.toast.terminalId === terminalId) cardsBlock = h(Toast, { toast: st.toast });
    else cardsBlock = mine.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0 } }, ...mine.map((c) => h(CardView, { key: c.id, card: c, ctx, fresh: false }))) : h('div', { style: { ...S.note, fontSize: 13 } }, 'The Coach has nothing for this thread yet.');
    const sees = threadObservations(st.signals, terminalId);
    const touched = activeGoals(st.memory).filter((g) => mine.some((c) => c.goal === g.id || g.detectors.includes(c.type) || g.measures.includes(c.measure)));
    return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 12 } },
      touched.length > 0 && h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--color-text-secondary)' } }, icon('target', null, 14), h('span', null, `Working on: ${touched.map((g) => g.text).join(' · ')}`)),
      cardsBlock,
      h('div', { 'data-testid': 'coach-thread-sees', style: S.section },
        h('div', { style: S.label }, 'WHAT THE COACH SEES IN THIS THREAD'),
        sees.length ? h('ul', { style: { margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 } }, ...sees.map((x, k) => h('li', { key: k, style: { margin: '3px 0' } }, x))) : h('div', { style: { ...S.note, fontSize: 12.5 } }, 'Nothing yet: the Coach sees a thread after your first prompt in it.')),
      h('div', null, h(ReviewButton, { scope: { kind: 'thread', ids: [terminalId] }, label: 'Review this thread' })),
      h(ReviewPanel, { terminalId }),
      h(Chat, { terminalId, sessionId }));
  }

  // ── talk with the Coach (spec section 4.9) ─────────────────────────────────────────────────
  async function ensureSignals(force = false) {
    if (store.getState().signalsLoaded && !force) return;
    const sig = await storage.get(PLUGIN, 'signals', null).catch(() => null);
    store.setState({ signals: sig, signalsLoaded: true });
  }
  async function saveChat(next) { store.setState({ chat: next }); await storage.set(PLUGIN, 'chat', next); }
  const CHAT_CAP = 'The Coach has used its budget for this week. The chat comes back when the week resets.';
  function actionLabel(a) {
    const p = a.payload || {};
    if (a.kind === 'add-goal') return `Add goal: ${p.text}`;
    if (a.kind === 'schedule') return `Set up: ${p.label || p.prompt}`;
    if (a.kind === 'create-skill') return `Create skill: ${p.name}`;
    if (a.kind === 'build-plugin') return 'Build the plugin';
    if (a.kind === 'new-threads') return `Open ${(p.prompts || []).length} new threads`;
    return a.kind;
  }
  /** A chat action: the same confirm-first paths as the cards; the click is the person's choice. */
  async function runAction(a, projectId) {
    const p = a.payload || {};
    const acts = d.actions || {};
    const at = projectId ? { projectId } : {};
    if (a.kind === 'add-goal' && typeof p.text === 'string') { const mapped = await mapText(p.text); await newGoal(p.text, mapped, 'user'); return; }
    if (a.kind === 'schedule' && typeof acts.openSchedule === 'function') { acts.openSchedule({ ...at, prompt: p.prompt, cron: p.cron, label: p.label }); return; }
    if (a.kind === 'create-skill' && typeof acts.createSkill === 'function') { void acts.createSkill({ name: p.name, description: p.description, body: p.body, ...at }); return; }
    if (a.kind === 'build-plugin' && typeof acts.openNewThreads === 'function') { acts.openNewThreads({ ...at, prompts: [buildPluginPrompt({ plugin: p.plugin, parts: cleanParts(p.parts) })] }); return; }
    if (a.kind === 'new-threads' && typeof acts.openNewThreads === 'function') acts.openNewThreads({ ...at, prompts: (p.prompts || []).filter((x) => typeof x === 'string') });
  }
  function Chat({ terminalId = null, sessionId = null }) {
    const chat = store((s) => s.chat);
    const draft = store((s) => s.chatDraft);
    const [scope, setScope] = useState(terminalId ? 'thread' : 'me');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [note, setNote] = useState(null);
    useEffect(() => { void ensureSignals(); }, []);
    useEffect(() => { if (draft) { setText(draft); store.setState({ chatDraft: null }); } }, [draft]);
    const tid = scope === 'thread' ? terminalId : null;
    const turns = (chat && Array.isArray(chat.turns) ? chat.turns : []).filter((x) => (tid ? x.terminalId === tid : !x.terminalId));
    const send = async () => {
      const q = text.trim();
      if (!q || busy) return;
      const st = store.getState();
      // "Review how I worked in this thread": a review job (the estimate first), not a chat call.
      if (/^\s*(please\s+)?review\b/i.test(q)) {
        await requestReview(tid ? { kind: 'thread', ids: [tid] } : lastDays(7));
        const at = now().toISOString();
        const tag = tid ? { terminalId: tid } : {};
        await saveChat(appendTurns(store.getState().chat, [{ role: 'user', text: q, at, ...tag }, { role: 'coach', text: 'I can do that. The review shows its cost first; nothing runs until you press Start.', at, ...tag }]));
        setText('');
        return;
      }
      const plan = planCall('more', st.settings, liveBudget(st.status.budget, now()), { harness: st.status.harness });
      if (plan.tier === 'none') { setNote(CHAT_CAP); return; }
      setBusy(true); setNote(null);
      try {
        await ensureSignals(true);
        const s2 = store.getState();
        const cards = tid ? s2.cards.filter((c) => c.terminalId === tid) : s2.cards;
        const ctx = chatContext(s2.signals, s2.measures && s2.measures.scores, s2.memory, cards, { now: now(), terminalId: tid });
        const r = await d.assist(PLUGIN, { ...chatPrompt(ctx, turns, q), harness: plan.harness, ...(plan.model ? { model: plan.model } : {}) }).catch(() => null);
        const ans = parseChat(r && r.text);
        if (!ans) { setNote('The Coach could not answer just now.'); return; }
        const at = now().toISOString();
        const tag = tid ? { terminalId: tid } : {};
        await saveChat(appendTurns(store.getState().chat, [{ role: 'user', text: q, at, ...tag }, { role: 'coach', text: ans.text, actions: ans.actions, at, ...tag }]));
        setText('');
      } finally { setBusy(false); }
    };
    return h('div', { 'data-testid': 'coach-chat', style: S.section },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('span', { style: S.label }, 'ASK THE COACH'), h('span', { style: { flex: 1 } }),
        terminalId && h('div', { role: 'radiogroup', 'aria-label': 'Chat about', style: { display: 'flex', gap: 4 } },
          ...[['thread', 'About this thread'], ['me', 'About me']].map(([v, l]) => h('button', { key: v, type: 'button', role: 'radio', 'aria-checked': scope === v, style: scope === v ? S.chipOn : S.chip, onClick: () => setScope(v) }, l))),
        h('button', { type: 'button', style: S.link, onClick: () => { const all = (store.getState().chat && store.getState().chat.turns) || []; void saveChat({ turns: all.filter((x) => (tid ? x.terminalId !== tid : !!x.terminalId)) }); } }, 'Clear chat')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, maxHeight: 360, overflowY: 'auto' } },
        turns.length === 0 && h('div', { style: { ...S.note, fontSize: 12.5 } }, tid ? 'Ask about this thread: "How could I have handed off more here?"' : 'Ask about your own use: "What should I automate first?"'),
        ...turns.map((x, k) => h('div', { key: k, style: { alignSelf: x.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '88%', padding: '7px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: x.role === 'user' ? 'var(--color-pane)' : 'var(--color-elevated)', fontSize: 12.5, color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap' } },
          x.text,
          Array.isArray(x.actions) && x.actions.length > 0 && h('div', { style: { ...S.row, marginTop: 6 } }, ...x.actions.map((a, n) => h('button', { key: n, type: 'button', style: S.btn, onClick: () => { void runAction(a, tid ? sessionId : undefined); } }, actionLabel(a))))))),
      note && h('div', { role: 'status', style: { ...S.note, fontSize: 12.5 } }, note),
      h('div', { style: { ...S.row, marginTop: 8 } },
        h('input', { type: 'text', 'aria-label': 'Ask the Coach', placeholder: 'Ask about how you use AI', value: text, style: { ...S.input, marginTop: 0, flex: 1, minWidth: 160 }, onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void send(); } }),
        h('button', { type: 'button', style: S.primary, disabled: busy, onClick: () => { void send(); } }, busy ? 'Thinking…' : 'Send')));
  }

  // ── cost this week (spec section 4.5; mockup part 5, right) ────────────────────────────────
  const LEVEL_NAME = { 'small-only': 'the small model only', economy: 'Economy', balanced: 'Balanced', thorough: 'Thorough', none: 'rules only' };
  const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
  const pctTxt = (n) => `${Math.round(n * 10) / 10}%`;
  function Cost() {
    const status = store((s) => s.status);
    const harness = status && status.harness === 'codex' ? 'codex' : 'claude';
    const [data, setData] = useState(null);
    useEffect(() => {
      let live = true;
      const api = d.api || {};
      const call = (fn, ...a) => (typeof fn === 'function' ? fn(PLUGIN, ...a).catch(() => null) : Promise.resolve(null));
      Promise.all([call(api.pluginAssistUsage), call(api.pluginAssistShare, { harness }), call(api.pluginBudget)])
        .then(([usage, share, budget]) => { if (live) setData({ usage, share, budget }); });
      return () => { live = false; };
    }, [harness]);
    const usage = data && data.usage;
    const week = data && data.share && data.share.sevenDay;
    const five = data && data.share && data.share.fiveHour;
    const cap = data && data.budget && typeof data.budget.percentWeekly === 'number' ? data.budget.percentWeekly : null;
    const used = status && status.budget && typeof status.budget.usedPercent === 'number' ? status.budget.usedPercent : (week ? week.pluginPercent : null);
    const row = (k, v) => h('div', { key: k, style: { display: 'flex', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--color-border)', fontSize: 12.5 } },
      h('span', { style: { width: 150, flexShrink: 0, color: 'var(--color-text-tertiary)' } }, k), h('span', { style: { color: 'var(--color-text-primary)', minWidth: 0 } }, v));
    return h('div', { 'data-testid': 'coach-cost', style: S.section },
      h('div', { style: S.label }, 'COST THIS WEEK'),
      !data ? h('div', { style: S.note }, 'Loading…') : h('div', { style: { marginTop: 6 } },
        row('Calls', usage ? `${usage.calls}${usage.byModel && usage.byModel.length ? ` (${usage.byModel.map((m) => `${m.model} ${m.calls}`).join(' · ')})` : ''}` : 'Not available right now'),
        row('Tokens', usage ? `${kTok(usage.inputTokens)} in · ${kTok(usage.outputTokens)} out` : '–'),
        row(`Share of your weekly ${harness === 'codex' ? 'Codex' : 'Claude'} limit`, week ? `≈ ${pctTxt(week.pluginPercent)} (estimate)${five ? ` · 5-hour: ≈ ${pctTxt(five.pluginPercent)}` : ''}` : 'Not known yet (estimate)'),
        row('Budget', cap === null ? 'No budget set' : h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          `${cap}% of your weekly limit`,
          h('span', { role: 'meter', 'aria-label': 'Budget used', 'aria-valuemin': 0, 'aria-valuemax': cap, 'aria-valuenow': used === null ? 0 : Math.round(used * 100) / 100, style: { ...S.bar, width: 120 } },
            h('span', { style: { ...S.barFill, display: 'block', width: `${used === null ? 0 : Math.min(100, (used / cap) * 100)}%`, background: 'var(--color-accent)' } })),
          used === null ? null : h('span', { style: S.src }, `${pctTxt(used)} used`)))),
      status && status.stepped && status.level && h('div', { style: { ...S.note, fontSize: 12.5 } }, `Near the budget, the Coach stepped down to ${LEVEL_NAME[status.level] || status.level}.`),
      h('div', { style: { ...S.note, fontSize: 11.5 } }, 'Runs on your own subscription. The share is an estimate: use outside Dispatch makes it read high.'),
      h('div', { style: { ...S.row, marginTop: 8 } }, h('button', { type: 'button', style: S.btn, onClick: () => { if (d.actions && typeof d.actions.openSettings === 'function') d.actions.openSettings(VIEW_KEY); } }, icon('gear', null, 14), 'Coach settings')));
  }

  // ── card history ──────────────────────────────────────────────────────────────────────────
  const STATE_WORD = { shown: 'Shown', dismissed: 'Dismissed', used: 'Used', down: 'Not helpful' };
  function History() {
    const cards = store((s) => s.cards);
    const cardState = store((s) => s.cardState);
    const list = [...cards].reverse();
    return h('div', { style: S.section },
      h('div', { style: S.label }, 'CARD HISTORY'),
      list.length === 0
        ? h('div', { style: { ...S.note, fontSize: 13 } }, 'No cards yet. The Coach shows one after it sees a pattern in your work.')
        : h('ul', { 'data-testid': 'coach-history', style: { listStyle: 'none', margin: '6px 0 0', padding: 0 } }, ...list.map((c) => {
          const cs = cardState[c.id];
          return h('li', { key: c.id, style: S.fact },
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { color: 'var(--color-text-primary)' } }, c.headline),
              h('div', { style: S.src }, [c.why, fmtDate(c.at)].filter(Boolean).join(' · '))),
            h('span', { style: S.src }, cs ? STATE_WORD[cs.state] || cs.state : 'New'));
        })));
  }

  // ── the weekly recap (spec section 4.2; mockup part 5) ─────────────────────────────────────
  function Recap() {
    const recap = store((s) => s.recap);
    const [hidden, setHidden] = useState(false);
    useEffect(() => { void markRecapSeen(); }, [recap && recap.at]);
    if (!recap || !Array.isArray(recap.patterns)) return null;
    const st = recap.stats || {};
    const stretch = recap.stretch;
    const start = () => {
      const a = (stretch && stretch.action) || {};
      const acts = d.actions || {};
      if (a.kind === 'schedule' && typeof acts.openSchedule === 'function') acts.openSchedule({ prompt: a.prompt, cron: a.cron, label: a.label });
      else if (a.kind === 'threads' && typeof acts.openNewThreads === 'function') acts.openNewThreads({ prompts: a.prompts || [] });
      else if (typeof acts.openNewThreads === 'function') acts.openNewThreads({ prompts: [a.text || a.prompt || ''] });
      else if (typeof d.copyText === 'function') { void d.copyText(a.text || a.prompt || ''); if (typeof d.hint === 'function') d.hint('Copied. Paste it into the message box.'); }
    };
    return h('div', { 'data-testid': 'coach-recap', style: S.section },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
        h('div', { style: { fontWeight: 650, fontSize: 15 } }, 'Your week with AI'),
        h('span', { style: S.src }, `${st.threads ?? 0} threads · ${st.days ?? 0} days · up to ${st.parallel ?? 1} at a time`)),
      h('ul', { style: { margin: '8px 0 0', paddingLeft: 18, fontSize: 13 } }, ...recap.patterns.map((p, i) => h('li', { key: i, style: { margin: '4px 0' } }, p))),
      stretch && !hidden && h('div', { style: { ...S.card, margin: '10px 0 0' } },
        h('div', { style: S.kicker }, "THIS WEEK'S STRETCH"),
        h('div', { style: S.head }, stretch.headline),
        h('div', { style: S.why }, [stretch.why, stretch.check].filter(Boolean).join(' ')),
        h('div', { style: S.row },
          h('button', { type: 'button', style: S.primary, onClick: start }, (stretch.action && stretch.action.label) || 'Start'),
          h('button', { type: 'button', style: S.btn, onClick: () => setHidden(true) }, 'Not this week'))),
      Array.isArray(recap.goals) && recap.goals.length > 0 && h(RecapGoals, { recap }),
      recap.learned && h('div', { style: { ...S.note, fontSize: 12.5 } }, recap.learned));
  }

  // Each goal's progress, and once a month: Keep, Done or Change (spec section 4.6).
  function RecapGoals({ recap }) {
    const memory = store((s) => s.memory);
    const [changing, setChanging] = useState(null); // { id, text }
    const asked = memory.dates['goals:asked'];
    const ask = recap.askGoals && !(asked && Date.parse(asked) >= Date.parse(recap.at));
    const answered = async (fn) => { const m = fn(store.getState().memory); await saveMemory({ ...m, dates: { ...m.dates, 'goals:asked': now().toISOString() } }); };
    return h('div', { style: { marginTop: 10 } },
      h('div', { style: S.label }, 'YOUR GOALS'),
      ...recap.goals.map((g) => {
        const live = memory.goals.find((x) => x.id === g.id);
        if (!live) return null;
        return h('div', { key: g.id, style: S.fact },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { color: 'var(--color-text-primary)' } }, live.text),
            h('div', { style: S.src }, `${g.progress} Next: ${g.next}`),
            changing && changing.id === g.id && h('div', { style: { ...S.row, marginTop: 6 } },
              h('input', { type: 'text', 'aria-label': 'Change the goal', value: changing.text, style: { ...S.input, marginTop: 0, flex: 1 }, onChange: (e) => setChanging({ id: g.id, text: e.target.value }) }),
              h('button', { type: 'button', style: S.primary, onClick: () => { const text = changing.text; setChanging(null); void changeGoal(g.id, text).then(() => answered((m) => m)); } }, 'Save'))),
          ask && live.status === 'active' && h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: S.src }, 'Is this goal still right?'),
            h('button', { type: 'button', 'aria-label': `Keep: ${live.text}`, style: S.btn, onClick: () => { void answered((m) => m); } }, 'Keep'),
            h('button', { type: 'button', 'aria-label': `Done: ${live.text}`, style: S.btn, onClick: () => { void answered((m) => setGoalStatus(m, g.id, 'done', now())); } }, 'Done'),
            h('button', { type: 'button', 'aria-label': `Change: ${live.text}`, style: S.btn, onClick: () => setChanging({ id: g.id, text: live.text }) }, 'Change')));
      }));
  }

  // ── your goals (spec section 4.6): up to 3, in your own words or from a suggestion ─────────
  const mapText = (text) => {
    const st = store.getState();
    const assist = typeof d.assist === 'function' ? (req) => d.assist(PLUGIN, req) : null;
    return mapGoal(text, { assist, settings: st.settings, budget: liveBudget(st.status.budget, now()) }).catch(() => mapGoal(text, { assist: null, settings: st.settings, budget: null }));
  };
  async function newGoal(text, mapped, source) {
    const r = addGoal(store.getState().memory, { text, measures: mapped.measures, detectors: mapped.detectors, source }, now());
    if (r.ok) await saveMemory(r.memory);
    return r.ok;
  }
  async function changeGoal(id, text) {
    const mapped = await mapText(text);
    await saveMemory(editGoal(store.getState().memory, id, text, mapped));
  }
  function Goals() {
    const memory = store((s) => s.memory);
    const doc = store((s) => s.measures);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const active = activeGoals(memory);
    const full = active.length >= MAX_ACTIVE;
    const taken = new Set(memory.goals.filter((g) => g.status === 'active').map((g) => g.text.toLowerCase()));
    const suggestions = (doc && Array.isArray(doc.suggestions) ? doc.suggestions : []).filter((g) => !taken.has(g.text.toLowerCase()));
    const add = async () => {
      const t = text.trim();
      if (!t || full || busy) return;
      setBusy(true);
      try { const mapped = await mapText(t); if (await newGoal(t, mapped, 'user')) setText(''); } finally { setBusy(false); }
    };
    return h('div', { 'data-testid': 'coach-goals', style: S.section },
      h('div', { style: S.label }, 'YOUR GOALS'),
      active.length === 0
        ? h('div', { style: { ...S.note, fontSize: 13 } }, 'Say how you want to improve. Cards that serve a goal come first.')
        : h('div', { style: { marginTop: 6 } }, ...active.map((g) => h('div', { key: g.id, style: S.fact },
          icon('target', null, 14),
          h('span', { style: { flex: 1, minWidth: 0, color: 'var(--color-text-primary)' } }, g.text),
          h('button', { type: 'button', 'aria-label': `Done: ${g.text}`, style: S.btn, onClick: () => { void saveMemory(setGoalStatus(store.getState().memory, g.id, 'done', now())); } }, 'Done'),
          h('button', { type: 'button', 'aria-label': `Delete goal: ${g.text}`, title: 'Delete', style: S.icon, onClick: () => { void saveMemory(removeItem(store.getState().memory, 'goal', g.id)); } }, icon('trash', 'Delete', 14))))),
      h('div', { style: { ...S.row, marginTop: 10 } },
        h('input', { type: 'text', 'aria-label': 'A goal, in your own words', placeholder: 'For example: hand off whole reports', value: text, disabled: full, style: { ...S.input, marginTop: 0, flex: 1, minWidth: 200 }, onChange: (e) => setText(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void add(); } }),
        h('button', { type: 'button', 'aria-label': 'Add goal', disabled: full || busy || !text.trim(), style: { ...S.primary, opacity: full || !text.trim() ? 0.5 : 1 }, onClick: () => { void add(); } }, busy ? 'Adding…' : 'Add')),
      full && h('div', { style: S.note }, `You have ${MAX_ACTIVE} goals. Mark one done to add another.`),
      !full && suggestions.length > 0 && h('div', { style: { marginTop: 10 } },
        h('div', { style: S.src }, 'SUGGESTED FROM YOUR WORK'),
        ...suggestions.map((g) => h('div', { key: g.text, style: S.fact },
          h('span', { style: { flex: 1, minWidth: 0 } }, g.text),
          h('button', { type: 'button', 'aria-label': `Edit: ${g.text}`, style: S.btn, onClick: () => setText(g.text) }, 'Edit'),
          h('button', { type: 'button', 'aria-label': `Add: ${g.text}`, style: S.btn, onClick: () => { void newGoal(g.text, g, 'suggested'); } }, icon('plus', null, 13), 'Add')))));
  }

  function CoachView() {
    const st = store((x) => x);
    return h('div', { style: { padding: '22px 26px 40px', maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
      h('div', null,
        h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Coach'),
        h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, 'One small next step at a time, from how you actually work. Your Coach data stays on this machine and is private to you.')),
      h(LookBack),
      h(ReviewPanel, {}),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
        h(ReviewButton, { scope: lastDays(7), label: 'Review my last week' }),
        h('button', { type: 'button', style: S.btn, onClick: () => { void saveCadence({ ...store.getState().cadence, lookbackAnswered: true }); void requestReview(lastDays(30), { backfill: true }); } }, 'Look back at the last 30 days')),
      h(Recap),
      h(Goals),
      st.settings.showMeasures !== false && h(Measures),
      h(Chat, {}),
      h(History),
      h(Knows),
      h(Cost));
  }

  // ── Settings → Coach (spec sections 2, 4.3, 5; mockup part 7): every behavior, with its default ──
  const SMALL_DEFAULT = { claude: 'claude-haiku-5-5', codex: 'gpt-6.1-terra', openrouter: 'anthropic/claude-haiku-5.5' };
  const HARNESS_NAME = { claude: 'Claude', codex: 'Codex', openrouter: 'OpenRouter' };
  async function saveSettings(next) {
    const s = withDefaults(next);
    store.setState({ settings: s });
    await settings.set(PLUGIN, s);
    return s;
  }
  async function saveBudget(patch) {
    // The daemon's budget first: the settings event that follows makes the worker read it at once.
    const s = withDefaults({ ...store.getState().settings, ...patch });
    const api = d.api || {};
    if (typeof api.setPluginBudget === 'function') await api.setPluginBudget(PLUGIN, { percentWeekly: s.budgetPercentWeekly, usdWeekly: s.budgetUsdWeekly }).catch((err) => { if (typeof d.hint === 'function') d.hint(`The budget was not saved: ${err && err.message ? err.message : err}`); });
    await saveSettings(s);
  }

  /** A number field that writes on blur or Enter, clamped to [min, max]. */
  function NumField({ label, value, min, max, step = 1, onSave, width = 70 }) {
    const [text, setText] = useState(String(value));
    useEffect(() => { setText(String(value)); }, [value]);
    const commit = () => {
      const n = Number(text);
      if (!Number.isFinite(n) || text.trim() === '') { setText(String(value)); return; }
      const v = Math.max(min, Math.min(max, n));
      setText(String(v));
      if (v !== value) void onSave(v);
    };
    return h('input', { type: 'number', 'aria-label': label, value: text, min, max, step, style: { ...S.input, marginTop: 0, width }, onChange: (e) => setText(e.target.value), onBlur: commit, onKeyDown: (e) => { if (e.key === 'Enter') commit(); } });
  }
  function TextField({ label, value, onSave, width = 200 }) {
    const [text, setText] = useState(value);
    useEffect(() => { setText(value); }, [value]);
    const commit = () => { const v = text.trim(); if (v && v !== value && /^\S{1,120}$/.test(v)) void onSave(v); else setText(value); };
    return h('input', { type: 'text', 'aria-label': label, value: text, style: { ...S.input, marginTop: 0, width }, onChange: (e) => setText(e.target.value), onBlur: commit, onKeyDown: (e) => { if (e.key === 'Enter') commit(); } });
  }
  function Radios({ label, value, options, onPick }) {
    return h('div', { role: 'radiogroup', 'aria-label': label, style: { display: 'flex', gap: 6, flexWrap: 'wrap' } }, ...options.map(([v, text]) =>
      h('button', { key: v, type: 'button', role: 'radio', 'aria-checked': value === v, style: value === v ? S.chipOn : S.chip, onClick: () => { if (value !== v) void onPick(v); } }, text)));
  }
  function Toggle({ label, on, onClick }) {
    const T = d.ui && d.ui.Toggle;
    return T ? h(T, { on, label, onClick }) : h('button', { type: 'button', role: 'switch', 'aria-checked': on, 'aria-label': label, style: on ? S.chipOn : S.chip, onClick }, on ? 'On' : 'Off');
  }
  const Line = ({ label, hint, children }) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--color-border)' } },
    h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { fontSize: 13, color: 'var(--color-text-primary)' } }, label), hint ? h('div', { style: S.src }, hint) : null),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' } }, children));
  const Group = (title, ...rows) => h('div', { style: { marginTop: 18 } }, h('div', { style: S.label }, title), ...rows);

  function TierPicker({ tier, s }) {
    const cur = (s.model && s.model[tier]) || { harness: 'claude', model: tier === 'small' ? SMALL_DEFAULT.claude : LARGE_DEFAULT.claude };
    const name = tier === 'small' ? 'Small model' : 'Large model';
    const set = (next) => saveSettings({ ...store.getState().settings, model: { ...store.getState().settings.model, mode: 'pick', [tier]: next } });
    return h(Line, { label: name, hint: tier === 'small' ? 'Checks each tip (cheap).' : 'Writes tips, More, and the weekly recap.' },
      h('select', { 'aria-label': `${name} harness`, value: cur.harness, style: { ...S.input, marginTop: 0, width: 120 }, onChange: (e) => { const harness = e.target.value; void set({ harness, model: (tier === 'small' ? SMALL_DEFAULT : LARGE_DEFAULT)[harness] }); } },
        ...Object.keys(HARNESS_NAME).map((k) => h('option', { key: k, value: k }, HARNESS_NAME[k]))),
      h(TextField, { label: name, value: cur.model, onSave: (model) => set({ harness: cur.harness, model }) }));
  }

  const THRESHOLD_HINT = {
    repeatedPrompt: 'The same prompt this many times in this many days', serialIndependent: 'Short threads in one project run one after another',
    idleWait: 'A thread busy this long while nothing else runs', stepByStep: 'One-line prompts in a row in one thread',
    noPlanBigTask: 'A long prompt with this many parts and no plan', fastApprove: 'An approval this soon after a long answer',
    narrowBreadth: 'This share of threads being one kind of work',
    skillFit: 'The same instructions in this many threads in this many days (at least this many characters)',
    pluginFit: 'The same multi-step workflow this many times in this many days, with no schedule',
  };
  function Advanced({ s }) {
    const th = s.advanced.thresholds;
    const setTh = (group, field, v) => saveSettings({ ...store.getState().settings, advanced: { ...store.getState().settings.advanced, thresholds: { ...store.getState().settings.advanced.thresholds, [group]: { ...store.getState().settings.advanced.thresholds[group], [field]: v } } } });
    return h('div', { 'data-testid': 'coach-advanced', style: { marginTop: 6 } },
      h(Line, { label: 'Show a card at this confidence or more', hint: 'The small model says how sure it is, from 0 to 1.' },
        h(NumField, { label: 'Show a card at this confidence or more', value: s.advanced.minConfidence, min: 0, max: 1, step: 0.05, onSave: (v) => saveSettings({ ...store.getState().settings, advanced: { ...store.getState().settings.advanced, minConfidence: v } }) }),
        h('span', { style: S.src }, 'default 0.7')),
      h(Line, { label: 'Hide a card after this many hours', hint: 'A card about something long past does not show.' },
        h(NumField, { label: 'Hide a card after this many hours', value: s.advanced.maxCardAgeHours ?? CARD_MAX_AGE_HOURS, min: 1, max: 720, step: 1, onSave: (v) => saveSettings({ ...store.getState().settings, advanced: { ...store.getState().settings.advanced, maxCardAgeHours: v } }) }),
        h('span', { style: S.src }, `default ${CARD_MAX_AGE_HOURS}`)),
      ...Object.entries(DEFAULT_THRESHOLDS).map(([group, fields]) => h(Line, { key: group, label: typeLabel(DETECTOR_OF_THRESHOLD[group]), hint: THRESHOLD_HINT[group] },
        ...Object.entries(fields).map(([field, def]) => h('span', { key: field, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h('span', { style: S.src }, field),
          h(NumField, { label: `${group} ${field}`, value: (th[group] && th[group][field]) ?? def, min: 0, max: 100000, step: field === 'share' ? 0.05 : 1, width: 64, onSave: (v) => setTh(group, field, v) }),
          h('span', { 'data-default': `${group}.${field}`, style: S.src }, `default ${def}`))))));
  }

  function Settings() {
    const s = store((st) => st.settings);
    const loaded = store((st) => st.loaded);
    const projects = d.stores && d.stores.useProjects ? d.stores.useProjects((p) => p.sessions) : [];
    const [adv, setAdv] = useState(false);
    if (!loaded) return null;
    const put = (patch) => saveSettings({ ...store.getState().settings, ...patch });
    const leave = new Set(s.leaveAlone || []);
    const picked = s.model && s.model.mode !== 'auto';
    return h('div', { 'data-testid': 'coach-settings', style: { fontSize: 13, color: 'var(--color-text-secondary)' } },
      Group('HOW OFTEN',
        h(Line, { label: 'How often', hint: 'Quiet: only the weekly recap and the right-column tab. Normal: up to 3 cards a day. Chatty: up to 8.' },
          h(Radios, { label: 'How often', value: s.howOften, options: [['off', 'Off'], ['quiet', 'Quiet'], ['normal', 'Normal'], ['chatty', 'Chatty']], onPick: (v) => put({ howOften: v }) })),
        h(Line, { label: 'Most cards in a day' }, h(NumField, { label: 'Most cards in a day', value: s.maxPerDay, min: 0, max: 20, onSave: (v) => put({ maxPerDay: v }) })),
        h(Line, { label: 'Most cards in one session' }, h(NumField, { label: 'Most cards in one session', value: s.maxPerSession, min: 0, max: 20, onSave: (v) => put({ maxPerSession: v }) })),
        h(Line, { label: 'Quiet hours', hint: 'No cards and no recap push in these hours.' },
          s.quietHours && h('input', { type: 'time', 'aria-label': 'Quiet from', value: s.quietHours.from, style: { ...S.input, marginTop: 0, width: 110 }, onChange: (e) => put({ quietHours: { ...s.quietHours, from: e.target.value } }) }),
          s.quietHours && h('input', { type: 'time', 'aria-label': 'Quiet to', value: s.quietHours.to, style: { ...S.input, marginTop: 0, width: 110 }, onChange: (e) => put({ quietHours: { ...s.quietHours, to: e.target.value } }) }),
          h(Toggle, { label: 'Quiet hours', on: !!s.quietHours, onClick: () => put({ quietHours: s.quietHours ? null : { from: '18:00', to: '08:00' } }) })),
        h(Line, { label: 'Cards on the phone' }, h(Toggle, { label: 'Cards on the phone', on: !!s.phone, onClick: () => put({ phone: !s.phone }) })),
        h(Line, { label: 'Mute shortcut', hint: 'Press ⌘K, then type "Mute coach".' })),
      Group('WHAT KIND',
        h(Line, { label: 'Prompt tips', hint: 'Better prompts: a plan first, the whole task at once.' }, h(Toggle, { label: 'Prompt tips', on: s.tipTypes.prompt !== false, onClick: () => put({ tipTypes: { ...s.tipTypes, prompt: s.tipTypes.prompt === false } }) })),
        h(Line, { label: '"Think bigger" tips', hint: 'Schedules, parallel threads, new kinds of work.' }, h(Toggle, { label: '"Think bigger" tips', on: s.tipTypes.thinkBigger !== false, onClick: () => put({ tipTypes: { ...s.tipTypes, thinkBigger: s.tipTypes.thinkBigger === false } }) })),
        h(Line, { label: 'Show the five measures', hint: 'The bars on the Coach screen. The Coach uses the measures either way.' }, h(Toggle, { label: 'Show the five measures', on: s.showMeasures !== false, onClick: () => put({ showMeasures: s.showMeasures === false }) })),
        h(Line, { label: 'Weekly recap in the app', hint: 'Monday, after 5 active days.' }, h(Toggle, { label: 'Weekly recap in the app', on: s.recap.inApp !== false, onClick: () => put({ recap: { ...s.recap, inApp: s.recap.inApp === false } }) })),
        h(Line, { label: 'Weekly recap push notification', hint: 'The recap only. Tips never arrive as push notifications.' }, h(Toggle, { label: 'Weekly recap push notification', on: !!s.recap.push, onClick: () => put({ recap: { ...s.recap, push: !s.recap.push } }) })),
        h(Line, { label: 'Projects to leave alone', hint: 'The Coach does not look at these projects.' },
          (projects || []).length === 0 ? h('span', { style: S.src }, 'No projects') : null),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10, padding: '6px 0' } }, ...(projects || []).map((p) => h('label', { key: p.id, style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5 } },
          h('input', { type: 'checkbox', 'aria-label': `Leave alone: ${p.name}`, checked: leave.has(p.id), onChange: () => put({ leaveAlone: leave.has(p.id) ? [...leave].filter((x) => x !== p.id) : [...leave, p.id] }) }), p.name)))),
      Group('COST AND MODELS',
        h(Line, { label: 'Thoroughness', hint: 'Economy uses the fewest large-model calls. Use my budget picks the most thorough level that fits your budget.' },
          h(Radios, { label: 'Thoroughness', value: s.thoroughness, options: [['economy', 'Economy'], ['balanced', 'Balanced'], ['thorough', 'Thorough'], ['budget', 'Use my budget']], onPick: (v) => put({ thoroughness: v }) })),
        h(Line, { label: 'Budget', hint: 'At most this share of the weekly limit of the account the Coach uses. Dispatch stops the calls at the budget.' },
          h(NumField, { label: 'Budget, percent of the weekly limit', value: s.budgetPercentWeekly, min: 0.1, max: 100, step: 0.5, onSave: (v) => saveBudget({ budgetPercentWeekly: v }) }), h('span', { style: S.src }, '%')),
        h(Line, { label: 'OpenRouter budget', hint: 'OpenRouter has no limit: its budget is dollars a week.' },
          h('span', { style: S.src }, '$'), h(NumField, { label: 'OpenRouter budget, dollars a week', value: s.budgetUsdWeekly, min: 0, max: 10000, step: 1, onSave: (v) => saveBudget({ budgetUsdWeekly: v }) })),
        h(Line, { label: 'Model', hint: 'Automatic uses the subscription with the most room, and never the last of a limit.' },
          h(Radios, { label: 'Model', value: picked ? 'pick' : 'auto', options: [['auto', 'Automatic'], ['pick', 'Pick a harness and models']], onPick: (v) => put({ model: v === 'auto' ? { mode: 'auto' } : { mode: 'pick', small: { harness: 'claude', model: SMALL_DEFAULT.claude }, large: { harness: 'claude', model: LARGE_DEFAULT.claude } } }) })),
        picked && h(TierPicker, { tier: 'small', s }),
        picked && h(TierPicker, { tier: 'large', s })),
      h('div', { style: { marginTop: 18 } },
        h('button', { type: 'button', 'aria-expanded': adv, style: S.btn, onClick: () => setAdv(!adv) }, 'Advanced'),
        adv && h(Advanced, { s })));
  }

  d.register(PLUGIN, {
    views: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachView }],
    settings: [{ id: 'coach', label: 'Coach', blurb: 'How often, what it may spend, what it remembers', icon: 'sparkle', Component: Settings }],
    slots: [{ id: 'card', slot: 'composer.before', Component: Card }],
    inspectorTabs: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachTab }],
    threadMenu: [{ id: 'review', label: 'Review this thread', onPick: ({ tab }) => { if (tab && tab.id) void requestReview({ kind: 'thread', ids: [tab.id] }); if (d.actions && typeof d.actions.setView === 'function') d.actions.setView(VIEW_KEY); } }],
    commands: [
      { id: 'mute-coach', label: 'Mute coach', run: () => { void muteAs('hour'); } },
      { id: 'unmute-coach', label: 'Unmute coach', run: () => { void doUnmute(); } },
    ],
  });

  return { store, ready };
}

export default function activate(d) {
  createCoach(d);
}
