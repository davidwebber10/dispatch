// Coach — a bundled Dispatch plugin (docs/superpowers/specs/2026-11-07-coach-design.md).
// It looks at how you work with AI and suggests one small next step at a natural break: a card
// under the message box, a tab in the right column, and its own screen. The worker
// (worker/index.mjs) watches the thread events and proposes candidates; this part shows cards,
// takes feedback, and keeps the memory you can see and edit. It never sends anything by itself.
//
// Documents it reads and writes: `cards` ({ items: card[] }, written by the judge), `cardState`
// ({ [cardId]: { state, at } }: shown, dismissed, used), `cadence` (lib/cadence.mjs).
import { withDefaults } from './lib/settings.mjs';
import { mayShow, emptyCadence, noteShown, dismiss, mute, unmute, isMuted, mutedForever, inQuietHours } from './lib/cadence.mjs';

const MEASURES = { ambition: 'AMBITION', delegation: 'DELEGATION', reuse: 'REUSE', judgment: 'JUDGMENT', breadth: 'BREADTH' };
const CLOSED = new Set(['dismissed', 'used', 'down']);
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
  primary: { height: 28, padding: '0 11px', borderRadius: 'var(--radius-md)', border: 'none', background: 'var(--color-accent)', color: 'var(--color-accent-foreground)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
  icon: { width: 28, height: 28, padding: 0, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 },
  more: { marginTop: 10, borderTop: '1px solid var(--color-border)', paddingTop: 10, fontSize: 13, color: 'var(--color-text-secondary)' },
  ex: { background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '8px 10px', margin: '6px 0', fontSize: 12.5, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' },
  exLabel: { display: 'block', marginBottom: 2, font: '600 10px var(--font-mono)', letterSpacing: 1, color: 'var(--color-text-tertiary)' },
  menu: { position: 'absolute', right: 10, bottom: 44, zIndex: 2, width: 230, padding: 5, borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-popover)', color: 'var(--color-popover-foreground)' },
  menuItem: { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 'var(--radius-sm)', border: 'none', background: 'none', color: 'inherit', fontSize: 12.5, cursor: 'pointer' },
  sep: { height: 1, margin: '4px 0', background: 'var(--color-border)' },
  note: { marginTop: 8, fontSize: 12, color: 'var(--color-text-tertiary)' },
  banner: { margin: '0 0 8px', fontSize: 12.5, color: 'var(--color-text-secondary)', background: 'var(--color-elevated)', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius-lg)', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8 },
  link: { border: 'none', background: 'none', padding: 0, color: 'var(--color-accent)', cursor: 'pointer', fontSize: 12.5 },
};

/** True while the person is writing: the composer has text and an editable element has focus. */
function typing(ctx) {
  if (!ctx.value || !String(ctx.value).trim()) return false;
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable === true);
}

function parseJson(text) {
  const m = /\{[\s\S]*\}/.exec(text || '');
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function createCoach(d, deps = {}) {
  const { h, hooks: { useState, useEffect }, storage, settings, events } = d;
  // The id the host gave this copy: a copy to local runs under its own id.
  const PLUGIN = d.id || 'coach';
  const now = deps.now || (() => new Date());

  // "More": the detail behind a card, one large-model call on click (the judge replaces this, plan Task 9).
  async function defaultRequestMore(card) {
    if (typeof d.assist !== 'function') return null;
    const s = store.getState().settings;
    const tier = s.model && s.model.large ? { harness: s.model.large.harness, model: s.model.large.model } : {};
    const r = await d.assist(PLUGIN, {
      system: 'You are a coach for people who use AI agents at work. Answer only with JSON: {"better": "a better version of what they wrote", "bullets": ["2 to 4 short lines: why it helps, and what to check"]}. Plain words, no jargon, no "should".',
      messages: [{ role: 'user', content: `Tip: ${card.headline}\nWhy: ${card.why}\nWhat they wrote: ${card.excerpt || '(not kept)'}` }],
      maxTokens: 600,
      ...tier,
    });
    const j = parseJson(r && r.text);
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
    offer: null,    // a tip type the person dismissed 3 times: offer to turn it off
  }));

  async function load() {
    const [s, cadence, cards, cardState] = await Promise.all([
      settings.get(PLUGIN, null).catch(() => null),
      storage.get(PLUGIN, 'cadence', null).catch(() => null),
      storage.get(PLUGIN, 'cards', null).catch(() => null),
      storage.get(PLUGIN, 'cardState', null).catch(() => null),
    ]);
    const firstRun = !cadence || !cadence.firstSeenAt;
    const cad = firstRun ? { ...emptyCadence(now()), ...(cadence || {}), firstSeenAt: now().toISOString() } : cadence;
    store.setState({ loaded: true, settings: withDefaults(s), cadence: cad, cards: (cards && Array.isArray(cards.items)) ? cards.items : [], cardState: cardState || {} });
    if (firstRun) await storage.set(PLUGIN, 'cadence', cad).catch(() => {});
  }
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
  const muteAs = (how) => saveCadence(mute(store.getState().cadence, how, now()));
  const doUnmute = () => saveCadence(unmute(store.getState().cadence));

  async function markShown(card) {
    if (card.id === WELCOME.id) return;
    await saveCadence(noteShown(store.getState().cadence, now()));
    await setCardState(card.id, 'shown');
  }
  async function onDismiss(card) {
    if (card.id === WELCOME.id) { await saveCadence({ ...store.getState().cadence, welcomeDone: true }); return; }
    const r = dismiss(store.getState().cadence, card.type, now());
    if (r.offerTurnOff) store.setState({ offer: card.type });
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
    put(data && data.better ? { status: 'ok', data } : { status: 'none' });
  }
  function tryIt(card, ctx, text) {
    const a = card.action || {};
    const acts = d.actions || {};
    const projectId = card.projectId || ctx.sessionId || undefined;
    if (text) ctx.set(text);
    else if (a.kind === 'schedule' && typeof acts.openSchedule === 'function') acts.openSchedule({ projectId, prompt: a.prompt, cron: a.cron, label: a.label });
    else if (a.kind === 'threads' && typeof acts.openNewThreads === 'function') acts.openNewThreads({ projectId, prompts: a.prompts || [] });
    else if (a.kind === 'settings') { if (typeof acts.openSettings === 'function') acts.openSettings(`plugin:${PLUGIN}:coach`); }
    else {
      // Without the dialog (or for a prompt tip), the composer gets the text: the person sends it, or not.
      const fill = a.text || a.prompt || (Array.isArray(a.prompts) ? a.prompts.join('\n\n') : '');
      if (fill) ctx.set(fill);
    }
    if (card.id === WELCOME.id) void saveCadence({ ...store.getState().cadence, welcomeDone: true });
    else void setCardState(card.id, 'used');
  }

  /** The card for this thread now, and whether it is new (not shown before). */
  function pick(st, terminalId, phone) {
    const t = now();
    if (mayShow(st.cadence, st.settings, t, 'card', { welcome: true, phone })) return { card: WELCOME, fresh: false };
    const live = st.settings.howOften !== 'off' && st.settings.howOften !== 'quiet' && !inQuietHours(st.settings.quietHours, t) && !(phone && !st.settings.phone);
    for (let i = st.cards.length - 1; i >= 0; i--) {
      const c = st.cards[i];
      if (c.terminalId && c.terminalId !== terminalId) continue;
      const cs = st.cardState[c.id];
      if (cs && CLOSED.has(cs.state)) continue;
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
      h('span', null, label), h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', style: S.link, onClick: () => { void doUnmute(); } }, 'Unmute'));
  }

  function CardView({ card, ctx, fresh }) {
    const [open, setOpen] = useState(false);
    const [menu, setMenu] = useState(false);
    const [why, setWhy] = useState(false);
    const more = store((s) => s.more[card.id]);
    useEffect(() => { if (fresh) void markShown(card); }, []);
    const welcome = card.id === WELCOME.id;
    const better = open && more && more.status === 'ok' ? more.data.better : null;
    const menuItem = (label, run) => h('button', { key: label, type: 'button', role: 'menuitem', style: S.menuItem, onClick: () => { setMenu(false); run(); } }, label);
    return h('div', { role: 'note', 'aria-label': 'Coach tip', 'data-testid': 'coach-card', style: S.card },
      h('button', { type: 'button', 'aria-label': 'Dismiss (not now)', title: 'Dismiss (not now)', style: S.x, onClick: () => { void onDismiss(card); } }, '✕'),
      h('div', { style: S.kicker }, 'COACH', card.measure && MEASURES[card.measure] ? h('span', { style: S.axis }, ` · ${MEASURES[card.measure]}`) : null),
      h('div', { style: S.head }, card.headline),
      h('div', { style: S.why }, card.why),
      open && h('div', { style: S.more },
        (!more || more.status === 'loading') && h('div', { style: S.note }, 'Getting more detail…'),
        more && more.status === 'none' && h('div', { style: S.note }, 'The Coach could not get more detail just now.'),
        more && more.status === 'ok' && [
          (more.data.wrote || card.excerpt) && h('div', { key: 'w', style: S.ex }, h('b', { style: S.exLabel }, 'YOU WROTE'), more.data.wrote || card.excerpt),
          h('div', { key: 't', style: S.ex }, h('b', { style: S.exLabel }, 'TRY'), more.data.better),
          (more.data.bullets || []).length > 0 && h('ul', { key: 'b', style: { margin: '4px 0 0', paddingLeft: 18 } }, ...more.data.bullets.map((b, i) => h('li', { key: i, style: { margin: '3px 0' } }, b))),
        ]),
      why && h('div', { style: S.note }, card.reason || 'The Coach saw this in your recent threads.'),
      h('div', { style: S.row },
        h('button', { type: 'button', style: S.primary, onClick: () => tryIt(card, ctx, better) }, better ? 'Use this prompt' : (card.action && card.action.label) || 'Try it'),
        !welcome && h('button', { type: 'button', style: S.btn, onClick: () => { if (open) setOpen(false); else { setOpen(true); void loadMore(card); } } }, open ? 'Less' : 'More'),
        h('span', { style: { flex: 1 } }),
        !welcome && h('button', { type: 'button', 'aria-label': 'Helpful', title: 'Helpful', style: S.icon }, '👍'),
        !welcome && h('button', { type: 'button', 'aria-label': 'Not helpful', title: 'Not helpful', style: S.icon }, '👎'),
        !welcome && h('button', { type: 'button', 'aria-label': 'More options', 'aria-haspopup': 'menu', 'aria-expanded': menu, style: S.icon, onClick: () => setMenu(!menu) }, '⋯')),
      menu && h('div', { role: 'menu', style: S.menu },
        menuItem('Mute for 1 hour', () => { void muteAs('hour'); }),
        menuItem('Mute for today', () => { void muteAs('today'); }),
        menuItem('Mute until I turn it on', () => { void muteAs('on'); }),
        h('div', { key: 's1', style: S.sep }),
        menuItem('Fewer tips like this', () => {}),
        menuItem('Turn off this type', () => {}),
        h('div', { key: 's2', style: S.sep }),
        menuItem('Why am I seeing this?', () => setWhy(true)),
        menuItem('What the Coach knows', () => { if (d.actions && typeof d.actions.setView === 'function') d.actions.setView(`plugin:${PLUGIN}:coach`); })));
  }

  function Card(ctx) {
    const st = store((s) => s);
    const phone = d.hooks.useIsMobile ? !!d.hooks.useIsMobile() : false;
    if (!st.loaded || !ctx.terminalId || (ctx.surface !== 'thread' && ctx.surface !== 'terminal')) return null;
    if (isMuted(st.cadence, now())) return h(MutedBanner, { cadence: st.cadence });
    if (st.busy[ctx.terminalId] || typing(ctx)) return null;
    const picked = pick(st, ctx.terminalId, phone);
    if (!picked) return null;
    return h(CardView, { key: picked.card.id, card: picked.card, ctx, fresh: picked.fresh });
  }

  function CoachView() {
    return h('div', { style: { padding: '22px 26px 40px', maxWidth: 820, margin: '0 auto' } },
      h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Coach'),
      h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, 'One small next step at a time, from how you actually work. Your Coach data stays on this machine and is private to you.'));
  }

  function CoachTab() {
    return h('div', { style: { padding: 12, fontSize: 13, color: 'var(--color-text-secondary)' } }, 'The Coach has nothing for this thread yet.');
  }

  function Settings() {
    return h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)' } }, 'Coach settings.');
  }

  d.register(PLUGIN, {
    views: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachView }],
    settings: [{ id: 'coach', label: 'Coach', blurb: 'How often, what it may spend, what it remembers', icon: 'sparkle', Component: Settings }],
    slots: [{ id: 'card', slot: 'composer.before', Component: Card }],
    inspectorTabs: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachTab }],
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
