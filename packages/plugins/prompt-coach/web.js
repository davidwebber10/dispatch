// Prompt coach — a bundled Dispatch plugin (docs/superpowers/specs/2026-11-07-plugins-design.md, section 13).
// After each prompt you send to a thread, the coach judges it against the rubric (rubric.md) through
// the daemon's assist model and shows one observation and one better version under the composer.
// The Coach screen shows your habits over the week. It never changes a prompt by itself and never
// posts to a thread.
export default function activate(d) {
  const { h, hooks: { useState, useEffect, useMemo, useDoc }, ui, storage, settings, events, assist, hint } = d;
  const PLUGIN = 'prompt-coach';
  const HABITS = {
    'dictates-steps': 'Dictates the steps', 'thin-context': 'Thin context', 'tiny-scope': 'Tiny scope',
    'no-plan': 'No plan first', 'no-verify': 'No verification asked', 'low-leverage': 'Low leverage', good: 'Good prompt',
  };
  const DEFAULT_SETTINGS = { style: 'normal', readPrompts: true, optOut: {} };

  // ── state shared by the card, the screen and the judge ──────────────────────────────────
  const useCoach = d.zustand.create((set, get) => ({
    latest: {},        // terminalId → observation
    recent: [],        // observations, newest first (this device's session; the store holds the rest)
    dismissed: {},     // terminalId → at of the dismissed observation
    busy: {},          // terminalId → true while judging
    setLatest: (terminalId, obs) => set({ latest: { ...get().latest, [terminalId]: obs }, recent: [obs, ...get().recent].slice(0, 200) }),
    dismiss: (terminalId, at) => set({ dismissed: { ...get().dismissed, [terminalId]: at } }),
    setBusy: (terminalId, on) => set({ busy: { ...get().busy, [terminalId]: on } }),
  }));

  let rubricText = null;
  async function rubric() {
    if (rubricText) return rubricText;
    const res = await d.fetch(PLUGIN, '/plugins/prompt-coach/rubric.md');
    rubricText = res.ok ? await res.text() : 'Judge the prompt for outcome, context, scope, plan, verification and leverage. Answer with JSON: {"scores":{},"habit":"good","note":"","better":""}.';
    return rubricText;
  }

  function parseJudgement(text) {
    const m = /\{[\s\S]*\}/.exec(text || '');
    if (!m) return null;
    try {
      const v = JSON.parse(m[0]);
      const scores = v.scores && typeof v.scores === 'object' ? v.scores : {};
      return { scores, habit: HABITS[v.habit] ? v.habit : 'good', note: String(v.note || '').trim(), better: String(v.better || '').trim() };
    } catch { return null; }
  }

  const styleLine = (style) => style === 'quiet' ? 'Be brief and gentle; skip the note when the prompt is fine.'
    : style === 'direct' ? 'Be direct and concrete; name the weakness plainly.' : 'Be clear, kind and specific.';

  // ── the judge: one assist call per prompt ────────────────────────────────────────────────
  const lastJudged = new Map(); // terminalId → at of the last prompt judged
  async function judge(e) {
    const s = await settings.get(PLUGIN, DEFAULT_SETTINGS);
    if (!s.readPrompts || !e.text || e.text.trim().length < 8) return;
    if (s.optOut && s.optOut[e.sessionId]) return;
    if (lastJudged.get(e.terminalId) === e.at) return;
    lastJudged.set(e.terminalId, e.at);
    useCoach.getState().setBusy(e.terminalId, true);
    try {
      const system = `${await rubric()}\n\n${styleLine(s.style)}`;
      const r = await assist(PLUGIN, { system, messages: [{ role: 'user', content: `The prompt to judge:\n\n<prompt>\n${e.text.slice(0, 4000)}\n</prompt>` }], maxTokens: 400 });
      const j = parseJudgement(r.text);
      if (!j) return;
      const obs = { terminalId: e.terminalId, sessionId: e.sessionId, at: e.at, prompt: e.text.slice(0, 200), ...j };
      await storage.set(PLUGIN, `obs:${e.terminalId}:${e.at}`, obs);
      useCoach.getState().setLatest(e.terminalId, obs);
    } catch (err) {
      console.warn('[prompt-coach] judging failed:', err && err.message ? err.message : err);
    } finally {
      useCoach.getState().setBusy(e.terminalId, false);
    }
  }
  events.on('thread:prompt', (e) => { if (e.source === 'user') void judge(e); });

  // ── the card under the composer ──────────────────────────────────────────────────────────
  function Card(ctx) {
    const terminalId = ctx.terminalId;
    const latest = useCoach((s) => (terminalId ? s.latest[terminalId] : undefined));
    const busy = useCoach((s) => (terminalId ? !!s.busy[terminalId] : false));
    const dismissedAt = useCoach((s) => (terminalId ? s.dismissed[terminalId] : undefined));
    if (!terminalId || (ctx.surface !== 'thread' && ctx.surface !== 'terminal')) return null;
    if (busy) return h('div', { style: { padding: '6px 10px 8px', fontSize: 12, color: 'var(--color-text-tertiary)' } }, 'Coach: looking at that prompt…');
    if (!latest || dismissedAt === latest.at) return null;
    if (latest.habit === 'good' && !latest.note) return null;
    return h('div', { role: 'note', 'data-testid': 'coach-card', style: { margin: '0 0 8px', padding: '10px 12px', borderRadius: 'var(--radius-lg)', border: '1px solid rgba(62,207,106,0.35)', background: 'rgba(62,207,106,0.08)', fontSize: 13, lineHeight: 1.5 } },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
        h('span', { style: { fontWeight: 600, color: 'var(--color-text-primary)' } }, 'Coach'),
        h('span', { style: { font: '500 10.5px var(--font-mono)', color: 'var(--color-accent)' } }, HABITS[latest.habit] || latest.habit),
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', onClick: () => useCoach.getState().dismiss(terminalId, latest.at), style: { background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 12 } }, 'Dismiss')),
      latest.note && h('div', { style: { color: 'var(--color-text-secondary)', marginTop: 2 } }, latest.note),
      latest.better && h('div', { style: { marginTop: 6, display: 'flex', gap: 8, alignItems: 'flex-start' } },
        h('div', { style: { flex: 1, minWidth: 0, color: 'var(--color-text-primary)', fontStyle: 'italic', overflowWrap: 'anywhere' } }, latest.better),
        h('button', { type: 'button', onClick: () => { ctx.set(latest.better); useCoach.getState().dismiss(terminalId, latest.at); }, style: { ...ui.styles.ghostBtn, flexShrink: 0 } }, 'Use this')));
  }

  // ── the Coach screen: this week's habits against last week ───────────────────────────────
  function CoachView() {
    const [obs, setObs] = useState(null);
    const bump = useCoach((s) => s.recent.length);
    useEffect(() => {
      let on = true;
      (async () => {
        const keys = (await storage.list(PLUGIN)).filter((k) => k.startsWith('obs:'));
        const items = [];
        for (const k of keys.slice(-400)) { const v = await storage.get(PLUGIN, k, null); if (v) items.push(v); }
        items.sort((a, b) => (a.at < b.at ? 1 : -1));
        if (on) setObs(items);
      })();
      return () => { on = false; };
    }, [bump]);
    const week = 7 * 24 * 3600 * 1000;
    const stats = useMemo(() => {
      if (!obs) return null;
      const now = Date.now();
      const count = (from, to) => {
        const out = {};
        for (const o of obs) { const t = new Date(o.at).getTime(); if (t >= from && t < to) out[o.habit] = (out[o.habit] || 0) + 1; }
        return out;
      };
      return { thisWeek: count(now - week, now + 1), lastWeek: count(now - 2 * week, now - week), total: obs.length };
    }, [obs]);
    const card = (children, extra) => h('div', { style: { padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', ...(extra || {}) } }, children);
    return h('div', { style: { padding: '22px 26px 40px', maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
      h('div', null,
        h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Coach'),
        h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, 'Your prompting habits this week, against last week. The coach looks at each prompt you send to a thread.')),
      obs === null && h('div', { style: { color: 'var(--color-text-tertiary)', fontSize: 13 } }, 'Loading…'),
      obs && obs.length === 0 && h('div', { style: { color: 'var(--color-text-tertiary)', fontSize: 13 } }, 'Nothing judged yet. Send a prompt to a thread; the coach watches from the next one.'),
      stats && obs.length > 0 && card([
        h('div', { key: 'l', style: ui.styles.sectionLabel }, 'HABITS'),
        ...Object.keys(HABITS).map((habit) => {
          const now = stats.thisWeek[habit] || 0; const before = stats.lastWeek[habit] || 0;
          const trend = now === before ? '' : now > before ? ` ↑ from ${before}` : ` ↓ from ${before}`;
          return h('div', { key: habit, style: { ...ui.styles.row, marginTop: 8 } },
            h('span', { style: ui.styles.item }, HABITS[habit]),
            h('span', { style: { font: '400 12px var(--font-mono)', color: habit === 'good' ? 'var(--color-accent)' : now > before ? 'var(--color-status-yellow)' : 'var(--color-text-tertiary)' } }, `${now}${trend}`));
        }),
      ]),
      obs && obs.length > 0 && card([
        h('div', { key: 'l', style: ui.styles.sectionLabel }, 'RECENT'),
        ...obs.slice(0, 20).map((o) => h('div', { key: o.at + o.terminalId, style: { marginTop: 10, fontSize: 13 } },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline' } },
            h('span', { style: { font: '500 10.5px var(--font-mono)', color: 'var(--color-accent)' } }, HABITS[o.habit] || o.habit),
            h('span', { style: { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' } }, new Date(o.at).toLocaleString())),
          h('div', { style: { color: 'var(--color-text-tertiary)', overflowWrap: 'anywhere' } }, `“${o.prompt}”`),
          o.note && h('div', { style: { color: 'var(--color-text-secondary)' } }, o.note))),
      ]),
    );
  }

  // ── settings ─────────────────────────────────────────────────────────────────────────────
  function Settings() {
    const [s, setS] = useState(null);
    const projects = d.stores.useProjects((st) => st.sessions);
    useEffect(() => { settings.get(PLUGIN, DEFAULT_SETTINGS).then(setS); }, []);
    if (!s) return h('div', { style: { color: 'var(--color-text-tertiary)', fontSize: 13 } }, 'Loading…');
    const save = (next) => { setS(next); void settings.set(PLUGIN, next).then(() => hint('Coach settings saved')); };
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h('span', { style: ui.styles.sectionLabel }, 'STYLE'),
      h('div', { style: { display: 'flex', gap: 6 } }, ...['quiet', 'normal', 'direct'].map((style) =>
        h('button', { key: style, type: 'button', onClick: () => save({ ...s, style }), style: { ...ui.styles.ghostBtn, ...(s.style === style ? { background: 'var(--color-accent)', color: '#08240F', borderColor: 'var(--color-accent)' } : {}) } }, style))),
      h('span', { style: ui.styles.sectionLabel }, 'WHAT IT MAY READ'),
      h('div', { style: ui.styles.row },
        h('span', { style: ui.styles.item }, 'Read my prompts and judge them'),
        h(ui.Toggle, { on: !!s.readPrompts, label: 'Read my prompts', onClick: () => save({ ...s, readPrompts: !s.readPrompts }) })),
      h('div', { style: { fontSize: 11.5, color: 'var(--color-text-tertiary)' } }, 'Each judged prompt is one model call through the daemon (Settings → Plugins shows the meter). The coach never changes a prompt by itself.'),
      h('span', { style: ui.styles.sectionLabel }, 'PROJECTS LEFT ALONE'),
      ...(projects || []).map((p) => h('div', { key: p.id, style: ui.styles.row },
        h('span', { style: ui.styles.item }, p.name),
        h(ui.Toggle, { on: !!(s.optOut && s.optOut[p.id]), label: `Leave ${p.name} alone`, onClick: () => save({ ...s, optOut: { ...(s.optOut || {}), [p.id]: !(s.optOut && s.optOut[p.id]) } }) }))),
    );
  }

  d.register(PLUGIN, {
    views: [{ id: 'coach', label: 'Coach', icon: 'sparkle', Component: CoachView }],
    settings: [{ id: 'coach', label: 'Prompt coach', blurb: 'Style, what it may read, projects left alone', icon: 'sparkle', Component: Settings }],
    slots: [{ id: 'card', slot: 'composer.before', Component: Card }],
  });
}
