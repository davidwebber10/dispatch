// Previews — a bundled Dispatch plugin (docs/superpowers/specs/2026-10-28-previews-design.md).
// Everything a thread handed the user to look at or copy, newest first: a badge on the project and
// thread headers (phone) and on the rail item (desktop), a sheet per project, a history across
// projects, and the viewer for the files. The documents live in this plugin's storage
// (`preview:<id>`); the files are references the daemon checks and serves.
export default function activate(d) {
  const { h, hooks: { useState, useEffect, useMemo }, ui, storage, events, icons, actions, apiPath } = d;
  const ID = d.id || 'previews';
  const VIEW = `plugin:${ID}:history`;
  const KEEP = 1000; // previews kept; the oldest seen ones are removed past this
  const fileUrl = (f) => apiPath(`/api/plugins/${encodeURIComponent(ID)}/files/${encodeURIComponent(f.fileId)}`);
  const newestFirst = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  const isPreview = (v) => !!v && typeof v === 'object' && typeof v.id === 'string' && Array.isArray(v.files);

  // ── the store ────────────────────────────────────────────────────────────────────────────
  const usePv = d.zustand.create((set, get) => ({
    items: [], loaded: false, loading: false, sheet: null,
    load: async () => {
      if (get().loading) return;
      set({ loading: true });
      try {
        const docs = await storage.all(ID);
        set({ items: docs.filter((x) => x.key.startsWith('preview:')).map((x) => x.value).filter(isPreview).sort(newestFirst), loaded: true });
        void get().prune();
      } catch { /* the next event or open tries again */ }
      finally { set({ loading: false }); }
    },
    upsert: (p) => set({ items: [p, ...get().items.filter((x) => x.id !== p.id)].sort(newestFirst) }),
    drop: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
    markSeen: async (id) => {
      const p = get().items.find((x) => x.id === id);
      if (!p || p.seenAt) return;
      const next = { ...p, seenAt: new Date().toISOString() };
      get().upsert(next); // the badge drops at once
      try { await storage.set(ID, `preview:${id}`, next); } catch { /* the next load corrects it */ }
    },
    markAllSeen: async (sessionId) => {
      for (const x of get().items.filter((x) => !x.seenAt && (!sessionId || x.sessionId === sessionId))) await get().markSeen(x.id);
    },
    remove: async (id) => {
      const p = get().items.find((x) => x.id === id);
      get().drop(id);
      try { await storage.remove(ID, `preview:${id}`); } catch { /* gone */ }
      for (const f of (p && p.files) || []) { try { await d.fetch(ID, `/api/plugins/${encodeURIComponent(ID)}/files/${encodeURIComponent(f.fileId)}`, { method: 'DELETE' }); } catch { /* never there */ } }
    },
    // The store stays under the plugin's document cap: past KEEP previews, the oldest seen ones go.
    prune: async () => {
      const items = get().items;
      if (items.length <= KEEP) return;
      const seen = items.filter((x) => x.seenAt).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const x of seen.slice(0, Math.max(0, items.length - KEEP))) await get().remove(x.id);
    },
    openSheet: (sessionId) => set({ sheet: sessionId }),
    closeSheet: () => set({ sheet: null }),
  }));
  const unseenOf = (items, sessionId) => items.reduce((n, x) => n + (!x.seenAt && (!sessionId || x.sessionId === sessionId) ? 1 : 0), 0);
  usePv.subscribe((s) => actions.setBadge(VIEW, unseenOf(s.items)));
  events.on('plugin:data', async (e) => {
    if (e.id !== ID || typeof e.key !== 'string' || !e.key.startsWith('preview:')) return;
    if (e.deleted) { usePv.getState().drop(e.key.slice('preview:'.length)); return; }
    const v = await storage.get(ID, e.key, null);
    if (isPreview(v)) usePv.getState().upsert(v);
  });
  void usePv.getState().load();

  // ── helpers ──────────────────────────────────────────────────────────────────────────────
  const kindOf = (f) => (f.mime.startsWith('image/') ? 'image' : f.mime === 'application/pdf' ? 'pdf' : f.mime === 'text/html' ? 'html' : f.mime === 'text/markdown' ? 'markdown' : 'text');
  const KIND_ICON = { image: icons.image, pdf: icons.pdf, html: icons.html, markdown: icons.file, text: icons.csv };
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const timeOf = (iso, now = new Date()) => {
    const t0 = new Date(iso);
    if (Number.isNaN(t0.getTime())) return '';
    const t = t0.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (t0.toDateString() === now.toDateString()) return `Today ${t}`;
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (t0.toDateString() === y.toDateString()) return `Yesterday ${t}`;
    return `${t0.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
  };
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 34, padding: '0 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 13, cursor: 'pointer', textDecoration: 'none' };

  function CopyButton({ text, label }) {
    const [state, setState] = useState('idle');
    useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t); }, [state]);
    const I = state === 'copied' ? icons.check : icons.copy;
    return h('button', { type: 'button', 'aria-label': label, title: label, onClick: () => d.copyText(text).then(() => setState('copied'), () => setState('error')),
      style: { ...chip, height: 30, padding: '0 10px', background: state === 'copied' ? 'var(--color-accent)' : 'var(--color-elevated)', color: state === 'copied' ? '#08240F' : 'var(--color-text-primary)', fontWeight: 600, fontSize: 12.5 } },
      h(I, { size: 14, weight: state === 'copied' ? 'bold' : 'regular' }),
      state === 'copied' ? 'Copied' : state === 'error' ? 'Could not copy' : label);
  }

  // One preview, the same on the phone's sheet and the desktop history: title, context line, note,
  // the text with Copy, pictures as thumbnails, other files as chips; any file opens the viewer.
  function Item({ preview, onDelete, showProject }) {
    const [viewing, setViewing] = useState(null);
    const unseen = !preview.seenAt;
    const projectName = d.stores.useProjects((s) => { const p = s.sessions.find((x) => x.id === preview.sessionId); return p ? p.name : preview.sessionName; });
    // The viewer fetches `src` itself for markdown and text (one app-root path; no second base prefix).
    const viewerFiles = preview.files.map((f) => ({ src: fileUrl(f), name: f.name, mime: f.mime, size: f.size }));
    const context = [showProject !== false ? projectName : null, preview.terminalLabel].filter(Boolean).join(' · ');
    const when = timeOf(preview.createdAt);
    const hasImage = preview.files.some((f) => kindOf(f) === 'image');
    const hasOther = preview.files.some((f) => kindOf(f) !== 'image');
    return h('div', { 'data-testid': 'preview-item', 'data-unseen': unseen ? 'true' : undefined, style: { display: 'flex', flexDirection: 'column', gap: 9, padding: '12px 14px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', position: 'relative' } },
      h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
        unseen && h('span', { 'aria-label': 'New', title: 'Not viewed yet', style: { width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', marginTop: 6, flexShrink: 0 } }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
            h('span', { style: { flex: 1, minWidth: 0, fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' } }, preview.title),
            when && h('span', { 'data-testid': 'preview-when', style: { flexShrink: 0, font: '400 11px var(--font-mono)', color: unseen ? 'var(--color-accent)' : 'var(--color-text-tertiary)', whiteSpace: 'nowrap' } }, when)),
          context && h('div', { title: context, style: { font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, context)),
        onDelete && h('button', { type: 'button', 'aria-label': 'Delete preview', title: 'Delete', onClick: () => onDelete(preview.id), style: { width: 28, height: 28, padding: 0, border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } }, h(icons.trash, { size: 15 }))),
      preview.note && h('div', { style: { fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' } }, preview.note),
      preview.text && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('pre', { 'data-testid': 'preview-text', style: { margin: 0, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'all', WebkitUserSelect: 'all', font: '13px/1.5 var(--font-mono)', color: 'var(--color-text-primary)', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' } }, preview.text),
        h('div', null, h(CopyButton, { text: preview.text, label: 'Copy text' }))),
      hasImage && h('div', { 'data-testid': 'preview-thumbs', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 } },
        ...preview.files.map((f, k) => (kindOf(f) !== 'image' ? null : h('button', { key: k, type: 'button', onClick: () => setViewing(k), 'aria-label': `Open ${f.name}`, title: `${f.name} · ${fmtSize(f.size)}`, style: { display: 'flex', flexDirection: 'column', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', minWidth: 0 } },
          h('img', { src: fileUrl(f), alt: '', loading: 'lazy', style: { width: '100%', aspectRatio: '1 / 1', objectFit: 'contain', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-pane)', display: 'block' } }),
          h('span', { style: { fontSize: 11.5, color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name))))),
      hasOther && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        ...preview.files.map((f, k) => { const kind = kindOf(f); if (kind === 'image') return null; const I = KIND_ICON[kind];
          return h('button', { key: k, type: 'button', onClick: () => setViewing(k), title: `${f.name} · ${fmtSize(f.size)}`, style: chip },
            h(I, { size: 16, style: { flexShrink: 0 } }),
            h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
            h('span', { style: { flexShrink: 0, font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)' } }, fmtSize(f.size))); })),
      viewing !== null && h(ui.FileViewer, { files: viewerFiles, index: viewing, onClose: () => setViewing(null) }));
  }

  // ── the project's previews in a bottom sheet (phone and desktop) ─────────────────────────
  // Load on open; mark seen on CLOSE, not open, so the unviewed dots show while you look.
  function Sheet() {
    const sessionId = usePv((s) => s.sheet);
    const items = usePv((s) => s.items);
    const loaded = usePv((s) => s.loaded);
    const projectName = d.stores.useProjects((s) => { const p = s.sessions.find((x) => x.id === sessionId); return p ? p.name : null; });
    useEffect(() => {
      if (!sessionId) return;
      void usePv.getState().load();
      return () => { void usePv.getState().markAllSeen(sessionId); };
    }, [sessionId]);
    if (!sessionId) return null;
    const mine = items.filter((p) => p.sessionId === sessionId);
    return h(ui.Modal, { open: true, sheet: true, title: projectName ? `Previews · ${projectName}` : 'Previews', onClose: () => usePv.getState().closeSheet() },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 6 } },
        mine.length === 0 && h('div', { style: { fontSize: 13, color: 'var(--color-text-tertiary)', padding: '8px 0 14px' } }, loaded ? 'Nothing here yet. A thread can hand you files and text with its preview tool.' : 'Loading…'),
        ...mine.map((p) => h(Item, { key: p.id, preview: p, showProject: false, onDelete: (id) => void usePv.getState().remove(id) }))));
  }

  // ── the history across projects (the rail view), grouped by day ──────────────────────────
  function History() {
    const items = usePv((s) => s.items);
    const loaded = usePv((s) => s.loaded);
    useEffect(() => { void usePv.getState().load(); return () => { void usePv.getState().markAllSeen(); }; }, []);
    const groups = useMemo(() => {
      const out = [];
      for (const p of items) {
        const t = new Date(p.createdAt);
        const day = Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
        const g = out[out.length - 1];
        if (g && g.day === day) g.items.push(p); else out.push({ day, items: [p] });
      }
      return out;
    }, [items]);
    return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '22px 26px 40px' } },
      h('div', { style: { maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 } },
        h('div', null,
          h('h1', { style: { margin: 0, fontSize: 18, fontWeight: 700 } }, 'Previews'),
          h('div', { style: { fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 } }, 'Files and text that threads handed you to look at or copy, newest first.')),
        items.length === 0 && h('div', { style: { fontSize: 13.5, color: 'var(--color-text-tertiary)', padding: '20px 0' } }, loaded ? 'Nothing yet. Ask a thread to show you a screenshot, a page, or a string with its preview tool.' : 'Loading…'),
        ...groups.map((g) => h('section', { key: g.day, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('h2', { style: { margin: 0, font: '500 10.5px var(--font-mono)', letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)' } }, g.day),
          ...g.items.map((p) => h(Item, { key: p.id, preview: p, onDelete: (id) => void usePv.getState().remove(id) }))))));
  }

  // ── the header eye: the project's unseen count, opens the sheet ──────────────────────────
  function Eye({ sessionId, floating }) {
    const n = usePv((s) => unseenOf(s.items, sessionId));
    if (!sessionId) return null;
    const box = floating
      ? { borderRadius: 'var(--radius-lg)', background: 'rgba(22,22,26,0.55)', border: '1px solid rgba(255,255,255,0.10)', height: 30, width: 32 }
      : { borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', height: 36, width: 36 };
    return h('button', { type: 'button', 'aria-label': 'Previews', title: n ? `${n} new previews` : 'Previews', onClick: () => usePv.getState().openSheet(sessionId),
      style: { ...box, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', color: n ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 } },
      h(icons.eye, { size: 20 }),
      n > 0 && h('span', { 'aria-label': `${n} new previews`, style: { position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 5px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: '#08240F', font: '700 10.5px var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, n > 99 ? '99+' : n));
  }
  const ProjectEye = ({ session }) => h(Eye, { sessionId: session ? session.id : null });
  const ThreadEye = ({ terminal, floating }) => h(Eye, { sessionId: terminal ? terminal.sessionId : null, floating: !!floating });

  d.register(ID, {
    views: [{ id: 'history', label: 'Previews', icon: 'eye', Component: History }],
    projectMenu: [{ id: 'open', label: 'Previews', onPick: ({ session }) => usePv.getState().openSheet(session.id) }],
    threadMenu: [{ id: 'open', label: 'Previews', onPick: ({ tab }) => usePv.getState().openSheet(tab.sessionId) }],
    slots: [
      { id: 'project-eye', slot: 'project.header.actions', Component: ProjectEye },
      { id: 'thread-eye', slot: 'thread.header.actions', Component: ThreadEye },
      { id: 'sheet', slot: 'app.overlay', Component: Sheet },
    ],
  });
}
