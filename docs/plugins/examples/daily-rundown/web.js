// Daily rundown — a spike plugin. Plain ES module, no build step: it uses the app's React
// through window.dispatch (handed in as `d`). `h` is React.createElement.
export default function activate(d) {
  const { h, hooks: { useState, useEffect }, api, ui, storage, hint } = d;
  const PLUGIN = 'daily-rundown';
  const hoursBack = () => storage.get(PLUGIN, 'hours', 24);
  const pinned = () => storage.get(PLUGIN, 'pinned', []);

  function timeAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  }

  function Rundown() {
    const [rows, setRows] = useState(null);
    const [pins, setPins] = useState(pinned());
    useEffect(() => {
      let on = true;
      (async () => {
        const since = Date.now() - hoursBack() * 3600 * 1000;
        const sessions = await api.listSessions();
        const out = [];
        for (const s of sessions) {
          const threads = await api.listTerminals(s.id);
          const recent = threads.filter((t) => new Date(t.lastActivityAt ?? t.createdAt).getTime() >= since);
          if (recent.length) out.push({ session: s, threads: recent.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1)) });
        }
        if (on) setRows(out);
      })().catch(() => { if (on) setRows([]); });
      return () => { on = false; };
    }, []);
    const card = (children) => h('div', { style: { padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' } }, children);
    return h('div', { style: { padding: '22px 26px 40px', maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
      h('div', null,
        h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Daily rundown'),
        h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, `Threads active in the last ${hoursBack()} hours, per project. A plugin screen, loaded from ~/.dispatch/plugins.`)),
      pins.length > 0 && card([
        h('div', { key: 'l', style: ui.styles.sectionLabel }, 'PINNED'),
        ...pins.map((p) => h('div', { key: p.id, style: { ...ui.styles.row, marginTop: 8 } },
          h('span', { style: ui.styles.item }, p.label),
          h('button', { style: ui.styles.ghostBtn, onClick: () => { const next = pins.filter((x) => x.id !== p.id); storage.set(PLUGIN, 'pinned', next); setPins(next); } }, 'Unpin'))),
      ]),
      rows === null && h('div', { style: { color: 'var(--color-text-tertiary)', fontSize: 13 } }, 'Loading…'),
      rows && rows.length === 0 && h('div', { style: { color: 'var(--color-text-tertiary)', fontSize: 13 } }, 'Nothing ran in that window.'),
      ...(rows ?? []).map(({ session, threads }) => card([
        h('div', { key: 'h', style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('span', { style: { fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-primary)' } }, session.name),
          h('span', { style: { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' } }, `${threads.length} thread${threads.length === 1 ? '' : 's'}`)),
        ...threads.map((t) => h('div', { key: t.id, style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 } },
          h('span', { style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: t.status === 'done' ? 'var(--color-accent)' : t.status === 'needs_input' ? 'var(--color-status-yellow)' : '#46464d' } }),
          h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-primary)' } }, t.label),
          h('span', { style: { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' } }, `${t.type} · ${t.status} · ${timeAgo(t.lastActivityAt ?? t.createdAt)}`))),
      ])),
    );
  }

  function Settings() {
    const [hours, setHours] = useState(hoursBack());
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h('span', { style: ui.styles.sectionLabel }, 'WINDOW'),
      h('div', { style: ui.styles.row },
        h('span', { style: ui.styles.item }, 'Hours to look back'),
        h('input', { type: 'number', min: 1, max: 168, value: hours, style: { ...ui.styles.fieldInput, width: 80 },
          onChange: (e) => { const v = Math.max(1, Number(e.target.value) || 24); setHours(v); storage.set(PLUGIN, 'hours', v); } })),
      h('div', { style: { fontSize: 11.5, color: 'var(--color-text-tertiary)' } }, 'A settings section a plugin added. It saves as you edit, like the rest of Settings.'));
  }

  d.register(PLUGIN, {
    views: [{ id: 'rundown', label: 'Rundown', icon: 'sun', mobileTab: true, Component: Rundown }],
    settings: [{ id: 'rundown', label: 'Daily rundown', blurb: 'How far back the rundown looks', icon: 'sun', Component: Settings }],
    threadMenu: [{ id: 'pin', label: 'Pin to rundown', onPick: ({ tab }) => {
      const next = [...pinned().filter((p) => p.id !== tab.id), { id: tab.id, label: tab.label }];
      storage.set(PLUGIN, 'pinned', next);
      hint(`Pinned "${tab.label}" to the rundown`);
    } }],
  });
}
