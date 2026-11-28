// Previews, named "Drops" in the app (2026-11-11) — a bundled Dispatch plugin
// (docs/superpowers/specs/2026-10-28-previews-design.md). Everything a thread handed the user to look at
// or copy, newest first: a badge on the project and thread headers (phone) and on the rail item
// (desktop), a sheet per project, a history across projects, and the viewer for the files. A list has two
// views, Rows (default) and Cards (1.3.0); the toggle is in the history's top row. The
// documents live in this plugin's storage (`preview:<id>`); the files are references the daemon checks
// and serves. The plugin id, the storage keys and the tool name (`preview`) keep the old name, so the
// stored drops and the running threads keep working.

/**
 * A font size that follows the app's text scale (Settings → Appearance): `px` at 100%, in rem.
 * The app sets the root font size to 16px times the scale, so 1rem is 16px at 100%.
 */
const rem = (px) => `${px / 16}rem`;

/**
 * The name the user reads, everywhere in this plugin (the view, the tab, the menu row, the sheet title,
 * the empty texts). To rename the feature, change this line (and `name` and the labels in plugin.json).
 */
export const NAME = 'Inbox';
/** One thing in it, and several ("Delete item", "3 new items"): "Inbox" has no plural of its own. */
const ONE = 'item';
const MANY = 'items';

/** A secret's text is removed this long after it was posted (also in mcp/kinds.mjs). */
const SECRET_TTL_MS = 24 * 3_600_000;
const KINDS = ['command', 'link', 'code', 'secret', 'steps', 'diff', 'table', 'doc', 'text', 'images', 'files'];
/** An http(s) URL, or null. Anything else (javascript:, file:, data:) is never a link. */
const httpUrl = (s) => {
  try { const u = new URL(String(s).trim()); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; }
};

/**
 * The kind of a drop (2026-11-11): the stored `kind`, or, for a drop without one (all drops before the
 * kinds), the look the content asks for: pictures only → images; other files only → files; a lone
 * http(s) URL → link; markdown → doc; any other text → text. Exported for the tests.
 */
export function inferKind(p) {
  if (p && typeof p.kind === 'string' && KINDS.includes(p.kind)) return p.kind;
  const files = (p && p.files) || [];
  const text = p && typeof p.text === 'string' ? p.text : '';
  if (!text.trim()) {
    if (files.length && files.every((f) => String(f.mime).startsWith('image/'))) return 'images';
    return files.length ? 'files' : 'text';
  }
  const t = text.trim();
  if (!/\s/.test(t) && httpUrl(t)) return 'link';
  if (looksLikeMarkdown(text, p.title)) return 'doc';
  return 'text';
}

/** A secret as the card shows it: dots and the last 4 characters (only for a value long enough to keep them hidden). */
export function maskSecret(v) {
  const s = String(v || '');
  return s.length >= 10 ? `••••${s.slice(-4)}` : '••••••••';
}

/** A secret past its 24 hours, with the text removed; null when nothing is to change. The same rule as mcp/kinds.mjs. */
export function expireSecret(doc, now = Date.now()) {
  if (!doc || doc.kind !== 'secret' || doc.text === null || doc.text === undefined) return null;
  const t = Date.parse(doc.createdAt);
  if (Number.isNaN(t) || now - t <= SECRET_TTL_MS) return null;
  return { ...doc, text: null, expired: true };
}

/** CSV rows (RFC 4180: quotes, doubled quotes, commas and new lines in quotes). Exported for the tests. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A table from JSON: a list of objects (the keys are the columns) or a list of lists (the first is the header). */
function tableFromJson(v) {
  const cellOf = (x) => (x === null || x === undefined ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  if (!Array.isArray(v) || v.length === 0) return null;
  if (v.every((r) => Array.isArray(r))) return v.map((r) => r.map(cellOf));
  if (v.every((r) => r && typeof r === 'object')) {
    const head = [];
    for (const r of v) for (const k of Object.keys(r)) if (!head.includes(k)) head.push(k);
    return [head, ...v.map((r) => head.map((k) => cellOf(r[k])))];
  }
  return null;
}
/**
 * A text preview that is a document, not a string to copy (2026-11-08): a title that ends in .md, or
 * two different markdown marks (a heading, bold, a list, a numbered list, a code fence, a table, a
 * link). A URL, a command or a token stays a monospace box. Exported for the tests.
 */
export function looksLikeMarkdown(text, title = '') {
  if (/\.(md|markdown)$/i.test(String(title || '').trim())) return true;
  const s = String(text || '');
  const marks = [
    /^#{1,6}\s+\S/m,
    /\*\*[^*\n]+\*\*/,
    /(^\s*[-*+]\s+\S.*\n){2,}/m,
    /(^\s*\d+[.)]\s+\S.*\n){2,}/m,
    /^```/m,
    /^\|.+\|\s*$/m,
    /\[[^\]\n]+\]\([^)\s]+\)/,
  ];
  return marks.filter((re) => re.test(s.endsWith('\n') ? s : `${s}\n`)).length >= 2;
}

/**
 * The history's filters (2026-11-07): a project, a source thread, and a search over the title, the
 * note, the text, the file names, the thread and the project. Exported for the tests.
 */
export function filterPreviews(items, { project = null, thread = null, query = '' }, nameOf = () => undefined) {
  const q = query.trim().toLowerCase();
  return items.filter((p) => {
    if (project && p.sessionId !== project) return false;
    if (thread && p.terminalId !== thread) return false;
    if (!q) return true;
    // A secret's value is never searched: typing a part of it must not tell whether it is there.
    const hay = [p.title, p.note, p.kind === 'secret' ? null : p.text, p.terminalLabel, nameOf(p.sessionId) ?? p.sessionName, ...(p.files || []).map((f) => f.name)].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  });
}

/** The projects that have previews, with counts, by name. */
export function projectsWithPreviews(items, nameOf = () => undefined) {
  const m = new Map();
  for (const p of items) { const r = m.get(p.sessionId) || { id: p.sessionId, name: nameOf(p.sessionId) ?? p.sessionName ?? p.sessionId, count: 0 }; r.count++; m.set(p.sessionId, r); }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The threads that posted previews (in one project when one is chosen), with counts, by name. */
export function threadsWithPreviews(items, project) {
  const m = new Map();
  for (const p of items) {
    if (!p.terminalId || (project && p.sessionId !== project)) continue;
    const r = m.get(p.terminalId) || { id: p.terminalId, label: p.terminalLabel || 'A thread', count: 0 }; r.count++; m.set(p.terminalId, r);
  }
  return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** How many previews a list shows before Show older (2026-11-09). */
const PAGE = 20;

export default function activate(d) {
  // SDK version 2 (plugin.json "sdk": 2): `d` is bound to this plugin, so no call names the plugin id.
  const { h, Fragment, hooks: { useState, useEffect, useMemo, useRef, useProjects, useThreads }, ui, docs, settings, files, events, icons, actions } = d;
  const ID = d.id || 'previews';
  const VIEW = `plugin:${ID}:history`;
  const KEEP = 1000; // previews kept; the oldest seen ones are removed past this
  // A card's picture asks for a small copy (`?thumb=480`, 2026-11-09): 185 full-size images closed the page on an iPhone.
  const fileUrl = (f) => files.url(f.fileId);
  const newestFirst = (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
  const isPreview = (v) => !!v && typeof v === 'object' && typeof v.id === 'string' && Array.isArray(v.files);

  // ── the store ────────────────────────────────────────────────────────────────────────────
  // Inbox → Send a secret (2026-11-12): the owner's secrets for a thread live in the daemon, not in this plugin's
  // documents (a thread with a storage grant reads those). Owner routes under this plugin's own path
  // (/api/plugins/previews/secrets), through the page's own session, with the bound header as the SDK sends it.
  const secretApi = async (method, p, body) => {
    const headers = { 'X-Dispatch-Plugin': ID, 'X-Dispatch-Plugin-Bound': ID, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    const res = await fetch(d.url(p), { method, credentials: 'same-origin', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && typeof data.error === 'string' && data.error) || `The daemon answered ${res.status}.`);
    return data;
  };
  const usePv = d.zustand.create((set, get) => ({
    items: [], loaded: false, loading: false, sheet: null,
    secrets: [],
    loadSecrets: async () => {
      try { const r = await secretApi('GET', '/api/plugins/previews/secrets'); set({ secrets: Array.isArray(r && r.secrets) ? r.secrets : [] }); } catch { /* the next open tries again */ }
    },
    addSecret: (r) => set({ secrets: [r, ...get().secrets.filter((x) => x.id !== r.id)] }),
    removeSecret: async (id) => {
      set({ secrets: get().secrets.filter((x) => x.id !== id) });
      try { await secretApi('DELETE', `/api/plugins/previews/secrets/${encodeURIComponent(id)}`); } catch { void get().loadSecrets(); }
    },
    load: async () => {
      void get().loadSecrets();
      if (get().loading) return;
      set({ loading: true });
      try {
        const all = await docs.entries();
        // A secret's text goes 24 hours after it was posted (2026-11-11): here, when the list loads, and at
        // each post of the tool. No timer.
        const now = Date.now();
        const expired = [];
        const items = all.filter((x) => x.key.startsWith('preview:')).map((x) => x.value).filter(isPreview)
          .map((p) => { const e = expireSecret(p, now); if (e) expired.push(e); return e || p; });
        set({ items: items.sort(newestFirst), loaded: true });
        for (const e of expired) { try { await docs.set(`preview:${e.id}`, e); } catch { /* the next load tries again */ } }
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
      try { await docs.set(`preview:${id}`, next); } catch { /* the next load corrects it */ }
    },
    markAllSeen: async (sessionId) => {
      for (const x of get().items.filter((x) => !x.seenAt && (!sessionId || x.sessionId === sessionId))) await get().markSeen(x.id);
    },
    remove: async (id) => {
      const p = get().items.find((x) => x.id === id);
      get().drop(id);
      try { await docs.delete(`preview:${id}`); } catch { /* gone */ }
      for (const f of (p && p.files) || []) { try { await files.remove(f.fileId); } catch { /* never there */ } }
    },
    // The store stays under the plugin's document cap: past KEEP previews, the oldest seen ones go.
    prune: async () => {
      const items = get().items;
      if (items.length <= KEEP) return;
      const seen = items.filter((x) => x.seenAt).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const x of seen.slice(0, Math.max(0, items.length - KEEP))) await get().remove(x.id);
    },
    // The list view (1.3.0): 'rows' (default) or 'cards', kept in the plugin's settings so it stays across
    // reloads, restarts and devices. A pick made before the load answers wins. A save keeps the other keys:
    // the daemon's `migrated` flag is in the same value, and without it old previews are copied in again.
    view: 'rows', picks: 0,
    loadView: async () => {
      const before = get().picks;
      try {
        const saved = await settings.get({});
        if (get().picks === before) set({ view: saved && saved.view === 'cards' ? 'cards' : 'rows' });
      } catch { /* the next event or reload tries again */ }
    },
    setView: async (view) => {
      set({ view, picks: get().picks + 1 });
      try {
        const saved = await settings.get({});
        await settings.set({ ...(saved && typeof saved === 'object' ? saved : {}), view: get().view });
      } catch { /* the view still changes for this visit */ }
    },
    openSheet: (sessionId) => set({ sheet: sessionId }),
    closeSheet: () => set({ sheet: null }),
  }));
  const unseenOf = (items, sessionId) => items.reduce((n, x) => n + (!x.seenAt && (!sessionId || x.sessionId === sessionId) ? 1 : 0), 0);
  usePv.subscribe((s) => actions.setBadge(VIEW, unseenOf(s.items)));
  events.on('plugin:data', async (e) => {
    if (e.id !== ID || typeof e.key !== 'string' || !e.key.startsWith('preview:')) return;
    if (e.deleted) { usePv.getState().drop(e.key.slice('preview:'.length)); return; }
    const v = await docs.get(e.key, null);
    if (isPreview(v)) usePv.getState().upsert(expireSecret(v) || v);
  });
  // A thread used a secret, or the owner sent or deleted one (on another device): the list again. No value in the event.
  events.on('inbox:secrets', () => { void usePv.getState().loadSecrets(); });
  events.on('plugin:settings', (e) => { if (e.id === ID) void usePv.getState().loadView(); });
  void usePv.getState().load();
  void usePv.getState().loadView();

  // A secret as an item of the lists, so the filters, the days and the pages treat it like the rest. Seen: the owner made it.
  const SECRET_PREFIX = 'inbox-secret:';
  const secretItem = (r) => ({ id: SECRET_PREFIX + r.id, secret: r, sessionId: r.sessionId, terminalId: r.terminalId || r.usedBy || null, terminalLabel: r.terminalLabel || r.usedByLabel || null,
    title: r.name, note: null, text: null, files: [], createdAt: r.createdAt, seenAt: r.createdAt });
  /** The documents and the secrets, newest first. Two selectors and a memo: one selector that made a new list each time would render forever. */
  function useAllItems() {
    const items = usePv((s) => s.items);
    const secrets = usePv((s) => s.secrets);
    return useMemo(() => (secrets.length ? [...items, ...secrets.map(secretItem)].sort(newestFirst) : items), [items, secrets]);
  }

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
  const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', height: 34, padding: '0 11px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: rem(13), cursor: 'pointer', textDecoration: 'none' };
  const solid = { ...chip, height: 30, padding: '0 12px', background: 'var(--color-accent)', borderColor: 'var(--color-accent)', color: 'var(--color-on-accent)', fontWeight: 600, fontSize: rem(12.5) };
  // Every monospace block wraps: no sideways scroll on a phone.
  const mono = { font: `${rem(13)}/1.5 var(--font-mono)`, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--color-text-primary)' };
  const block = { margin: 0, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)' };
  const row = { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' };
  const I = (name) => icons[name] || icons.file;

  // The kinds (2026-11-11): an icon, a label and a color, so an item tells its kind at a glance.
  const KIND = {
    command: { label: 'Command', icon: 'terminal', color: 'var(--color-green)' },
    link: { label: 'Link', icon: 'link', color: 'var(--color-blue)' },
    code: { label: 'Code', icon: 'code', color: 'var(--color-purple)' },
    secret: { label: 'Secret', icon: 'key', color: 'var(--color-orange)' },
    steps: { label: 'Steps', icon: 'list-numbers', color: 'var(--color-cyan)' },
    diff: { label: 'Diff', icon: 'git-diff', color: 'var(--color-pink)' },
    table: { label: 'Table', icon: 'table', color: 'var(--color-yellow)' },
    doc: { label: 'Doc', icon: 'file', color: 'var(--color-text-emphasis)' }, // not the accent: the accent is the command's green in the default theme
    text: { label: 'Text', icon: 'text-t', color: 'var(--color-text-secondary)' },
    images: { label: 'Images', icon: 'image', color: 'var(--color-status-coral)' },
    files: { label: 'Files', icon: 'paperclip', color: 'var(--color-text-tertiary)' },
  };
  // Copy: `label` is the text on the button, `aria` its name (default the label); `compact` is the icon alone.
  // The empty view (owner, 2026-11-13: "higher quality empty view: icon and center aligned with a bit
  // of top padding"). One look for the thread tab, the project sheet and the Inbox screen.
  function EmptyState({ title, body, loading }) {
    return h('div', { 'data-testid': 'inbox-empty', role: 'status', style: { display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 6, padding: '44px 20px 28px' } },
      h('span', { 'aria-hidden': true, style: { width: 48, height: 48, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6, background: 'color-mix(in srgb, var(--color-text-emphasis) 6%, transparent)', border: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)' } },
        h(icons.tray, { size: 22 })),
      h('div', { style: { fontSize: rem(14), fontWeight: 600, color: 'var(--color-text-primary)' } }, loading ? 'Loading…' : title),
      !loading && body && h('div', { style: { maxWidth: 270, fontSize: rem(12.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' } }, body));
  }

  function CopyButton({ text, label, aria, compact }) {
    const [state, setState] = useState('idle');
    useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t); }, [state]);
    const Icon = state === 'copied' ? icons.check : icons.copy;
    const name = aria || label;
    const on = state === 'copied';
    const look = compact
      ? { ...chip, width: 32, height: 30, padding: 0, justifyContent: 'center', flexShrink: 0 }
      : { ...chip, height: 30, padding: '0 10px', fontWeight: 600, fontSize: rem(12.5) };
    return h('button', { type: 'button', 'aria-label': name, title: on ? 'Copied' : name, onClick: () => ui.copyText(text).then(() => setState('copied'), () => setState('error')),
      style: { ...look, background: on ? 'var(--color-accent)' : 'var(--color-elevated)', color: on ? 'var(--color-on-accent)' : 'var(--color-text-primary)' } },
      h(Icon, { size: 14, weight: on ? 'bold' : 'regular' }),
      !compact && (on ? 'Copied' : state === 'error' ? 'Could not copy' : label));
  }

  // One command: a `$` prompt, the command (wraps), and its own Copy.
  function CommandRow({ command, aria, first }) {
    return h('div', { 'data-testid': 'drop-command', style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 5px 5px 10px', borderTop: first ? 'none' : '1px solid var(--color-border)' } },
      h('span', { 'aria-hidden': true, style: { font: `600 ${rem(13)}/30px var(--font-mono)`, color: 'var(--color-green)', userSelect: 'none', WebkitUserSelect: 'none', flexShrink: 0 } }, '$'),
      h('code', { style: { ...mono, flex: 1, minWidth: 0, padding: '5px 0', userSelect: 'all', WebkitUserSelect: 'all' } }, command),
      h(CopyButton, { text: command, aria, compact: true }));
  }
  const terminal = { ...block, background: 'var(--color-terminal)', overflow: 'hidden' };

  function CommandBlock({ preview }) {
    const commands = Array.isArray(preview.commands) && preview.commands.length ? preview.commands : String(preview.text || '').split(/\r?\n/).filter((c) => c.trim());
    const many = commands.length > 1;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      preview.cwd && h('div', { style: { font: `400 ${rem(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)', overflowWrap: 'anywhere' } }, `in ${preview.cwd}`),
      h('div', { style: terminal }, ...commands.map((c, i) => h(CommandRow, { key: i, command: c, first: i === 0, aria: many ? `Copy command ${i + 1}` : 'Copy command' }))),
      many && h('div', null, h(CopyButton, { text: commands.join('\n'), label: 'Copy all', aria: 'Copy all commands' })));
  }

  function LinkBlock({ preview }) {
    const url = String(preview.url || preview.text || '').trim();
    const u = httpUrl(url);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { style: { ...block, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2 } },
        u && h('div', { style: { fontSize: rem(13.5), fontWeight: 600, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' } }, u.host),
        h('div', { 'data-testid': 'drop-url', style: { ...mono, fontSize: rem(12), color: 'var(--color-link)', userSelect: 'all', WebkitUserSelect: 'all' } }, url)),
      h('div', { style: row },
        u && h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open link', style: solid }, h(I('arrow-square-out'), { size: 14 }), 'Open'),
        h(CopyButton, { text: url, label: 'Copy', aria: 'Copy link' })));
  }

  function CodeBlock({ preview }) {
    return h('div', { style: { ...block, overflow: 'hidden' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 4px 4px 10px', borderBottom: '1px solid var(--color-border)' } },
        h('span', { 'data-testid': 'drop-language', style: { flex: 1, font: `500 ${rem(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)', textTransform: 'lowercase' } }, preview.language || 'code'),
        h(CopyButton, { text: preview.text, aria: 'Copy code', compact: true })),
      h('pre', { 'data-testid': 'drop-code', style: { ...mono, margin: 0, padding: '8px 12px', maxHeight: 280, overflowY: 'auto', fontSize: rem(12.5) } }, preview.text));
  }

  const lineKind = (l) => (/^(\+\+\+ |--- |diff --git |index )/.test(l) ? 'file' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx');
  const LINE_STYLE = {
    file: { color: 'var(--color-text-secondary)', fontWeight: 600 },
    hunk: { color: 'var(--color-text-tertiary)', background: 'color-mix(in srgb, var(--color-blue) 8%, transparent)' },
    add: { background: 'color-mix(in srgb, var(--color-green) 16%, transparent)' },
    del: { background: 'color-mix(in srgb, var(--color-red) 16%, transparent)' },
    ctx: {},
  };
  function DiffBlock({ preview }) {
    const lines = String(preview.text || '').replace(/\n$/, '').split(/\r?\n/);
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { 'data-testid': 'drop-diff', style: { ...block, padding: '6px 0', maxHeight: 320, overflowY: 'auto' } },
        ...lines.map((l, i) => { const k = lineKind(l); return h('div', { key: i, 'data-line': k, style: { ...mono, fontSize: rem(12.5), padding: '0 10px', minHeight: '1.5em', ...LINE_STYLE[k] } }, l); })),
      h('div', null, h(CopyButton, { text: preview.text, label: 'Copy', aria: 'Copy diff' })));
  }

  function StepsBlock({ preview }) {
    const steps = Array.isArray(preview.steps) ? preview.steps : [];
    return h('ol', { 'data-testid': 'drop-steps', style: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 } },
      ...steps.map((st, i) => h('li', { key: i, style: { display: 'flex', gap: 9, alignItems: 'flex-start' } },
        h('span', { 'aria-hidden': true, style: { width: 22, height: 22, flexShrink: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--color-cyan) 16%, transparent)', color: 'var(--color-cyan)', font: `700 ${rem(11.5)} var(--font-sans)` } }, i + 1),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5, paddingTop: 2 } },
          h('div', { style: { fontSize: rem(13.5), lineHeight: 1.45, color: 'var(--color-text-primary)', overflowWrap: 'anywhere' } }, st.text),
          st.command && h('div', { style: terminal }, h(CommandRow, { command: st.command, first: true, aria: `Copy command for step ${i + 1}` }))))));
  }

  // A secret: masked until Reveal; Copy copies the value. The value is in the page only while revealed.
  function SecretBlock({ preview }) {
    const [shown, setShown] = useState(false);
    const expired = !!preview.expired || !preview.text || !!expireSecret(preview);
    if (expired) return h('div', { style: { ...block, padding: '9px 12px', fontSize: rem(13), color: 'var(--color-text-tertiary)' } }, 'This secret expired (24 hours after it was sent). Ask the thread again if you still need it.');
    const Eye = icons.eye; // the label says Reveal or Hide; one icon keeps the app's first load small
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { 'data-testid': 'drop-secret', style: { ...block, ...mono, padding: '9px 12px', letterSpacing: shown ? 0 : '1px', userSelect: shown ? 'all' : 'none', WebkitUserSelect: shown ? 'all' : 'none' } }, shown ? preview.text : maskSecret(preview.text)),
      h('div', { style: row },
        h(CopyButton, { text: preview.text, label: 'Copy', aria: 'Copy secret' }),
        h('button', { type: 'button', 'aria-label': shown ? 'Hide secret' : 'Reveal secret', 'aria-pressed': shown, onClick: () => setShown((v) => !v), style: { ...chip, height: 30, padding: '0 10px', fontWeight: 600, fontSize: rem(12.5) } },
          h(Eye, { size: 14 }), shown ? 'Hide' : 'Reveal'),
        h('span', { style: { fontSize: rem(11.5), color: 'var(--color-text-tertiary)' } }, 'Removed 24 hours after it was sent')));
  }

  // A table: CSV text, or the drop's .csv/.json file. The first 50 rows; the header stays on top.
  const TABLE_ROWS = 50;
  function TableBlock({ preview }) {
    const source = (preview.files || []).find((f) => /\.(csv|json)$/i.test(f.name) || f.mime === 'text/csv' || f.mime === 'application/json');
    const fromText = preview.text ? parseCsv(preview.text) : null;
    const [rows, setRows] = useState(fromText);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
      if (fromText || !source) return;
      let on = true;
      fetch(fileUrl(source)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status))))).then((t) => {
        if (!on) return;
        const json = /\.json$/i.test(source.name) || source.mime === 'application/json';
        let out = null;
        try { out = json ? tableFromJson(JSON.parse(t)) : parseCsv(t); } catch { out = null; }
        if (out) setRows(out); else setFailed(true);
      }).catch(() => { if (on) setFailed(true); });
      return () => { on = false; };
    }, [preview.id]);
    const shownRows = rows || fromText;
    if (!shownRows) return h('div', { style: { fontSize: rem(12.5), color: 'var(--color-text-tertiary)' } }, failed ? 'Could not read the table.' : 'Loading the table…');
    const [head = [], ...body] = shownRows;
    const more = body.length - TABLE_ROWS;
    const cell = { padding: '5px 9px', borderBottom: '1px solid var(--color-border)', textAlign: 'left', verticalAlign: 'top', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' };
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('div', { style: { ...block, maxHeight: 300, overflow: 'auto' } },
        h('table', { 'data-testid': 'drop-table', style: { borderCollapse: 'separate', borderSpacing: 0, width: '100%', font: `${rem(12)}/1.4 var(--font-mono)`, color: 'var(--color-text-primary)' } },
          h('thead', null, h('tr', null, ...head.map((c, i) => h('th', { key: i, style: { ...cell, position: 'sticky', top: 0, background: 'var(--color-elevated)', fontWeight: 600, color: 'var(--color-text-secondary)' } }, c)))),
          h('tbody', null, ...body.slice(0, TABLE_ROWS).map((r, i) => h('tr', { key: i }, ...head.map((_, j) => h('td', { key: j, title: r[j] || undefined, style: cell }, r[j] ?? ''))))))),
      h('div', { style: { ...row, justifyContent: 'space-between' } },
        h('span', { style: { fontSize: rem(11.5), color: 'var(--color-text-tertiary)' } }, more > 0 ? `+${more} more rows` : `${body.length} ${body.length === 1 ? 'row' : 'rows'}`),
        preview.text && h(CopyButton, { text: preview.text, label: 'Copy CSV', aria: 'Copy table' })));
  }

  // What an open item shows, the same in both views and all three lists: the note, the kind's own block,
  // pictures as thumbnails, other files as chips; any file opens the viewer.
  function ItemBody({ preview }) {
    const [viewing, setViewing] = useState(null);
    const [reading, setReading] = useState(false);
    const kind = inferKind(preview);
    const isDoc = kind === 'doc';
    const docName = /\.(md|markdown)$/i.test(preview.title) ? preview.title : `${preview.title}`;
    // The viewer fetches `src` itself for markdown and text (one app-root path; no second base prefix).
    // A picture opens on the card's cached small copy, then the 1600 copy; Original opens the file (2026-11-11).
    const viewerFiles = preview.files.map((f) => (kindOf(f) === 'image' && f.mime !== 'image/svg+xml'
      ? { src: fileUrl(f), name: f.name, mime: f.mime, size: f.size, placeholderSrc: `${fileUrl(f)}?thumb=480`, displaySrc: `${fileUrl(f)}?thumb=1600` }
      : { src: fileUrl(f), name: f.name, mime: f.mime, size: f.size }));
    const hasImage = preview.files.some((f) => kindOf(f) === 'image');
    const hasOther = preview.files.some((f) => kindOf(f) !== 'image');
    const text = typeof preview.text === 'string' && preview.text ? preview.text : null;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      preview.note && h('div', { style: { fontSize: rem(13), lineHeight: 1.5, color: 'var(--color-text-secondary)', overflowWrap: 'anywhere' } }, preview.note),
      kind === 'command' && h(CommandBlock, { preview }),
      kind === 'link' && h(LinkBlock, { preview }),
      kind === 'code' && text && h(CodeBlock, { preview }),
      kind === 'secret' && h(SecretBlock, { preview }),
      kind === 'steps' && h(StepsBlock, { preview }),
      kind === 'diff' && text && h(DiffBlock, { preview }),
      kind === 'table' && h(TableBlock, { preview }),
      text && isDoc && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        // The document rendered, cut at a height with a fade; tap it (or Read) for the whole thing.
        h('div', { 'data-testid': 'preview-doc', role: 'button', tabIndex: 0, 'aria-label': `Open ${docName}`, onClick: () => setReading(true), onKeyDown: (e) => { if (e.key === 'Enter') setReading(true); },
          style: { maxHeight: 260, overflow: 'hidden', cursor: 'pointer', padding: '2px 14px 4px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-pane)', fontSize: rem(14), lineHeight: 1.55, WebkitMaskImage: 'linear-gradient(to bottom, #000 70%, transparent)', maskImage: 'linear-gradient(to bottom, #000 70%, transparent)' } },
          h(ui.Markdown, { source: text })),
        h('div', { style: row },
          h('button', { type: 'button', 'aria-label': `Read ${docName}`, onClick: () => setReading(true), style: solid },
            h(icons.file, { size: 14 }), 'Read'),
          h(CopyButton, { text, label: 'Copy text' }))),
      text && (kind === 'text' || kind === 'images' || kind === 'files') && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('pre', { 'data-testid': 'preview-text', style: { ...block, ...mono, maxHeight: 220, overflow: 'auto', userSelect: 'all', WebkitUserSelect: 'all', padding: '10px 12px' } }, text),
        h('div', null, h(CopyButton, { text, label: 'Copy text' }))),
      hasImage && h('div', { 'data-testid': 'preview-thumbs', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 } },
        ...preview.files.map((f, k) => (kindOf(f) !== 'image' ? null : h('button', { key: k, type: 'button', onClick: () => setViewing(k), 'aria-label': `Open ${f.name}`, title: `${f.name} · ${fmtSize(f.size)}`, style: { display: 'flex', flexDirection: 'column', gap: 4, padding: 0, border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', minWidth: 0 } },
          h('img', { src: `${fileUrl(f)}?thumb=480`, alt: '', decoding: 'async', style: { width: '100%', aspectRatio: '1 / 1', objectFit: 'contain', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-pane)', display: 'block' } }),
          h('span', { style: { fontSize: rem(11.5), color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name))))),
      hasOther && h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
        ...preview.files.map((f, k) => { const fk = kindOf(f); if (fk === 'image') return null; const FI = KIND_ICON[fk];
          return h('button', { key: k, type: 'button', onClick: () => setViewing(k), title: `${f.name} · ${fmtSize(f.size)}`, style: chip },
            h(FI, { size: 16, style: { flexShrink: 0 } }),
            h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.name),
            h('span', { style: { flexShrink: 0, font: `400 ${rem(10.5)} var(--font-mono)`, color: 'var(--color-text-tertiary)' } }, fmtSize(f.size))); })),
      viewing !== null && h(ui.FileViewer, { files: viewerFiles, index: viewing, onClose: () => setViewing(null) }),
      reading && text && h(ui.FileViewer, { files: [{ src: '', name: docName, mime: 'text/markdown', size: text.length, loadText: async () => text }], index: 0, onClose: () => setReading(false) }));
  }

  // ── Send a secret (2026-11-12): the owner hands a thread a secret by a short ID ─────────────
  // The scope: a thread (from its tab) or a project (from its sheet; from the Inbox view, a picked project). The
  // value goes to the daemon once and is never shown again: after Send, the sheet shows the ID and a line to copy.
  const label = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: rem(12), fontWeight: 600, color: 'var(--color-text-secondary)' };
  const field = { height: 36, padding: '0 10px', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: `400 ${rem(15)} var(--font-sans)`, minWidth: 0 };
  function SendSecret({ sessionId, terminalId, terminalLabel, onClose }) {
    const projects = useProjects();
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [reveal, setReveal] = useState(false);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [made, setMade] = useState(null);
    const project = sessionId || picked;
    const projectName = (projects.find((x) => x.id === project) || {}).name;
    const ready = !!name.trim() && value.length > 0 && !!project && !busy;
    const send = async () => {
      if (!ready) return;
      setBusy(true); setError(null);
      try {
        const r = await secretApi('POST', '/api/plugins/previews/secrets', { name: name.trim(), value, sessionId: project, ...(terminalId ? { terminalId } : {}), allowReveal: reveal });
        setValue(''); // the value leaves the page at once
        setMade(r);
        usePv.getState().addSecret(r);
      } catch (e) { setError(e && e.message ? e.message : 'Could not send the secret.'); }
      finally { setBusy(false); }
    };
    const scope = terminalId
      ? `For ${terminalLabel ? `${terminalLabel}, ` : ''}this thread only.`
      : project ? `For any thread of ${projectName || 'this project'}.` : null;
    const line = made ? `The secret "${made.name}" is in my ${NAME}: ${made.id}` : '';
    return h(ui.Modal, { open: true, sheet: true, title: made ? 'Secret sent' : 'Send a secret', onClose },
      h('div', { 'data-testid': 'send-secret', style: { display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 8 } },
        made
          ? h(Fragment, null,
            h('div', { style: { fontSize: rem(13), lineHeight: 1.5, color: 'var(--color-text-secondary)' } }, 'Give the thread this ID. It works once, for 24 hours. The value is not shown again.'),
            h('div', { style: { ...block, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '14px 12px' } },
              h('span', { 'data-testid': 'secret-id', style: { font: `700 ${rem(30)}/1.1 var(--font-mono)`, letterSpacing: '6px', color: 'var(--color-text-primary)', userSelect: 'all', WebkitUserSelect: 'all' } }, made.id)),
            h('div', { style: row },
              h(CopyButton, { text: made.id, label: 'Copy ID' }),
              h(CopyButton, { text: line, label: 'Copy line', aria: 'Copy line' })),
            h('div', { style: { ...block, ...mono, fontSize: rem(12.5), padding: '8px 12px', color: 'var(--color-text-secondary)' } }, line),
            h('div', null, h('button', { type: 'button', onClick: onClose, style: solid }, 'Done')))
          : h(Fragment, null,
            !sessionId && !terminalId && h('div', { style: label }, 'Project',
              h(ui.Select, { value: picked, onChange: setPicked, ariaLabel: 'Project', placeholder: 'Choose a project',
                options: projects.filter((x) => !x.archived).map((x) => ({ value: x.id, label: x.name })) })),
            scope && h('div', { style: { fontSize: rem(12.5), color: 'var(--color-text-tertiary)' } }, scope),
            h('label', { style: label }, 'Name',
              h('input', { type: 'text', 'aria-label': 'Name', value: name, maxLength: 100, placeholder: 'Stripe key', autoComplete: 'off', onChange: (e) => setName(e.target.value), style: field })),
            h('label', { style: label }, 'Value',
              h('input', { type: 'password', 'aria-label': 'Value', value, autoComplete: 'new-password', spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true',
                onChange: (e) => setValue(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') void send(); }, style: { ...field, fontFamily: 'var(--font-mono)' } })),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', { style: { fontSize: rem(13), fontWeight: 600, color: 'var(--color-text-primary)' } }, 'Let the thread read it'),
                h('div', { style: { fontSize: rem(11.5), lineHeight: 1.45, color: 'var(--color-text-tertiary)' } }, reveal ? 'The thread may get the value itself.' : 'Off: the thread can only write it to a file or to Doppler.')),
              h(ui.Toggle, { on: reveal, onClick: () => setReveal((v) => !v), label: 'Let the thread read it' })),
            error && h('div', { role: 'alert', style: { fontSize: rem(12.5), color: 'var(--color-status-red)' } }, error),
            h('div', { style: row },
              h('button', { type: 'button', disabled: !ready, onClick: () => void send(), style: { ...solid, opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'default' } },
                h(I('paper-plane'), { size: 14, weight: 'bold' }), busy ? 'Sending…' : 'Send'),
              h('span', { style: { fontSize: rem(11.5), color: 'var(--color-text-tertiary)' } }, 'One use. Gone after 24 hours.')))));
  }

  function SendSecretButton({ onClick, style }) {
    return h('button', { type: 'button', title: 'Send Secret', onClick, style: { ...chip, height: 44, padding: '0 10px', borderColor: 'var(--color-border-strong)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0, ...style } },
      h(I('paper-plane'), { size: 16, 'aria-hidden': true }), 'Send Secret');
  }

  // A secret the owner sent: its name, its ID, its scope and its state. The value is never in the page.
  const SECRET_STATE = {
    waiting: { label: 'Waiting', color: 'var(--color-orange)' },
    used: { label: 'Used', color: 'var(--color-green)' },
    expired: { label: 'Expired', color: 'var(--color-text-tertiary)' },
  };
  const whereTo = (to) => {
    if (!to) return null;
    if (to.kind === 'file') return to.name ? `${to.name} in ${to.path}` : to.path;
    if (to.kind === 'doppler') return `Doppler ${to.name}`;
    if (to.kind === 'reveal') return 'read by the thread';
    return null;
  };
  function SecretBody({ item, showProject }) {
    const r = item.secret;
    const project = useProjects().find((x) => x.id === r.sessionId);
    const projectName = project ? project.name : null;
    const st = SECRET_STATE[r.state] || SECRET_STATE.expired;
    const scope = r.terminalId ? `Thread ${r.terminalLabel || 'a thread'} only${showProject !== false && projectName ? ` · ${projectName}` : ''}` : `Any thread of ${projectName || 'the project'}`;
    const detail = r.state === 'used' ? `Used by ${r.usedByLabel || 'a thread'} · ${timeOf(r.usedAt)}`
      : r.state === 'waiting' ? `Usable until ${timeOf(r.expiresAt)}`
        : 'The value was deleted after 24 hours';
    const to = r.state === 'used' ? whereTo(r.usedTo) : null;
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        h('span', { 'data-testid': 'sent-secret-id', style: { font: `700 ${rem(15)} var(--font-mono)`, letterSpacing: '2px', color: r.state === 'waiting' ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)', userSelect: 'all', WebkitUserSelect: 'all' } }, r.id),
        r.state === 'waiting' && h(CopyButton, { text: r.id, aria: 'Copy ID', compact: true }),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px', borderRadius: 'var(--radius-pill)', background: `color-mix(in srgb, ${st.color} 15%, transparent)`, color: st.color, font: `600 ${rem(10.5)} var(--font-sans)` } }, st.label),
        r.allowReveal && h('span', { title: 'The thread may read the value', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: rem(11.5), color: 'var(--color-text-tertiary)' } }, h(icons.eye, { size: 13 }), 'Readable')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, font: `400 ${rem(11.5)} var(--font-mono)`, color: 'var(--color-text-tertiary)', overflowWrap: 'anywhere' } },
        h('span', null, scope),
        h('span', { style: { color: r.state === 'used' ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)' } }, detail),
        to && h('span', { style: { color: 'var(--color-text-secondary)' } }, `→ ${to}`)));
  }

  // ── the lists (1.3.0): Rows or Cards; a tap opens an item in place, one at a time ────────────
  const dayOf = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }); };
  const clockOf = (iso) => { const t = new Date(iso); return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const kindFor = (p) => (p.secret ? 'secret' : inferKind(p));
  const clamp = (lines) => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' });
  const oneLine = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
  const tapIcon = { width: 44, height: 44, padding: 0, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', textDecoration: 'none' };
  const metaFont = { font: `400 ${rem(11)} var(--font-mono)`, color: 'var(--color-text-tertiary)' };
  const frame = { borderRadius: 'var(--radius-lg)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' };
  const removeItem = (p) => (p.secret ? void usePv.getState().removeSecret(p.secret.id) : void usePv.getState().remove(p.id));
  const seen = (p) => { if (!p.secret && !p.seenAt) void usePv.getState().markSeen(p.id); };
  const imagesOf = (p) => (p.files || []).map((f, k) => ({ f, k })).filter((x) => kindOf(x.f) === 'image');
  const viewerOf = (list) => list.map((f) => (kindOf(f) === 'image' && f.mime !== 'image/svg+xml'
    ? { src: fileUrl(f), name: f.name, mime: f.mime, size: f.size, placeholderSrc: `${fileUrl(f)}?thumb=480`, displaySrc: `${fileUrl(f)}?thumb=1600` }
    : { src: fileUrl(f), name: f.name, mime: f.mime, size: f.size }));
  // No lazy loading: Safari never starts a lazy image inside the sheet. The page of 20 bounds the count.
  const thumb = (f, size) => h('img', { src: `${fileUrl(f)}?thumb=480`, alt: '', decoding: 'async', style: { width: size, height: size, objectFit: 'cover', objectPosition: 'top', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', background: 'var(--color-pane)' } });
  const secretExpired = (p) => !!p.expired || !p.text || !!expireSecret(p);
  /** What one tap copies for an item, or null. */
  const copyOf = (p, kind) => {
    if (p.secret) return p.secret.state === 'waiting' ? { text: p.secret.id, aria: 'Copy ID' } : null;
    if (kind === 'command') {
      const text = Array.isArray(p.commands) && p.commands.length ? p.commands.join('\n') : p.text || '';
      return text ? { text, aria: 'Copy command' } : null;
    }
    if (kind === 'secret') return secretExpired(p) ? null : { text: p.text, aria: 'Copy secret' };
    if (!p.text) return null;
    if (kind === 'link') return { text: p.url || p.text, aria: 'Copy link' };
    return { text: p.text, aria: kind === 'code' ? 'Copy code' : kind === 'diff' ? 'Copy diff' : kind === 'table' ? 'Copy table' : 'Copy text' };
  };

  function TapCopy({ copy, onDone }) {
    const [state, setState] = useState('idle');
    useEffect(() => { if (state === 'idle') return; const t = setTimeout(() => setState('idle'), 1600); return () => clearTimeout(t); }, [state]);
    const Icon = state === 'copied' ? icons.check : state === 'error' ? icons.x : icons.copy;
    const name = state === 'copied' ? 'Copied' : state === 'error' ? 'Could not copy' : copy.aria;
    return h('button', { type: 'button', 'aria-label': name, title: name, onClick: () => ui.copyText(copy.text).then(() => { setState('copied'); if (onDone) onDone(); }, () => setState('error')),
      style: { ...tapIcon, color: state === 'copied' ? 'var(--color-accent)' : 'var(--color-text-secondary)' } }, h(Icon, { size: 18, weight: state === 'copied' ? 'bold' : 'regular' }));
  }

  /** The one-tap action at the right of a closed row: a thumbnail, Open, or Copy. */
  function QuickAction({ p, kind }) {
    const [viewing, setViewing] = useState(false);
    const images = imagesOf(p);
    if (images.length) {
      return h(Fragment, null,
        h('button', { type: 'button', 'aria-label': images.length > 1 ? `Open ${images.length} images` : `Open ${images[0].f.name}`, onClick: () => { setViewing(true); seen(p); }, style: { ...tapIcon, position: 'relative' } },
          thumb(images[0].f, 40),
          images.length > 1 && h('span', { 'aria-hidden': true, style: { position: 'absolute', right: 0, bottom: 0, minWidth: 18, height: 18, padding: '0 4px', boxSizing: 'border-box', borderRadius: 'var(--radius-pill)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-primary)', font: `600 ${rem(10.5)}/16px var(--font-sans)` } }, images.length)),
        viewing && h(ui.FileViewer, { files: viewerOf(p.files), index: images[0].k, onClose: () => setViewing(false) }));
    }
    if (kind === 'link') {
      const u = httpUrl(p.url || p.text);
      if (u) return h('a', { href: u.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open link', onClick: () => seen(p), style: tapIcon }, h(I('arrow-square-out'), { size: 18 }));
    }
    const copy = copyOf(p, kind);
    return copy ? h(TapCopy, { copy, onDone: () => seen(p) }) : null;
  }

  function KindTile({ kind, unseen }) {
    const k = KIND[kind];
    return h('span', { title: k.label, style: { position: 'relative', width: 32, height: 32, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-md)', background: `color-mix(in srgb, ${k.color} 15%, transparent)`, color: k.color } },
      h(I(k.icon), { size: 17, weight: 'bold', 'aria-label': k.label }),
      unseen && h('span', { 'aria-label': 'New', title: 'Not viewed yet', style: { position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: '50%', background: 'var(--color-accent)', border: '2px solid var(--color-elevated)' } }));
  }

  /** The open item: all of its content, then the kind, the time and Delete. */
  function FullItem({ p, showProject }) {
    const kind = kindFor(p);
    return h('div', { 'data-inbox-body': '', style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      p.secret ? h(SecretBody, { item: p, showProject }) : h(ItemBody, { preview: p }),
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h('span', { style: metaFont }, h('span', { 'data-testid': 'drop-kind' }, KIND[kind].label), ' · ', h('span', { 'data-testid': 'preview-when' }, timeOf(p.createdAt))),
        h('button', { type: 'button', 'aria-label': p.secret ? 'Delete secret' : `Delete ${ONE}`, onClick: () => removeItem(p), style: { ...chip, height: 44, border: 'none', background: 'transparent', color: 'var(--color-text-tertiary)' } }, h(icons.trash, { size: 16 }), 'Delete')));
  }

  /** The head of an item: the tile, the title, a context line. In a closed one the title is one line. */
  function Head({ p, open, meta, onToggle }) {
    const unseen = !p.seenAt;
    return h('button', { type: 'button', 'aria-expanded': open, onClick: onToggle, style: { flex: 1, minWidth: 0, minHeight: 56, display: 'flex', alignItems: open ? 'flex-start' : 'center', gap: 10, padding: open ? '10px 0 6px 10px' : '4px 0 4px 10px', border: 'none', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' } },
      h(KindTile, { kind: kindFor(p), unseen }),
      h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
        h('span', { 'data-inbox-title': '', style: { fontSize: rem(14), lineHeight: 1.35, fontWeight: unseen ? 700 : 500, color: 'var(--color-text-primary)', ...(open ? { overflowWrap: 'anywhere' } : oneLine) } }, p.title),
        h('span', { style: { display: 'flex', gap: 8, ...metaFont } },
          h('span', { style: { flex: 1, ...oneLine } }, meta),
          !open && h('span', { style: { flexShrink: 0, color: unseen ? 'var(--color-accent)' : 'var(--color-text-tertiary)' } }, clockOf(p.createdAt)))));
  }

  /** A card's short look at its content: pictures in a strip, the first command, the link, 3 lines. */
  function Peek({ p, onOpen }) {
    const kind = kindFor(p);
    const [viewing, setViewing] = useState(null);
    const images = imagesOf(p);
    const copy = copyOf(p, kind);
    const box = { display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 10, minHeight: 44, borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)', background: 'var(--color-pane)' };
    const code = { font: `400 ${rem(12)}/1.45 var(--font-mono)`, color: 'var(--color-text-primary)' };
    const tapOpen = { display: 'block', width: '100%', padding: 0, border: 'none', background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer' };
    const more = (text) => h('div', { style: { fontSize: rem(12), color: 'var(--color-link)', paddingTop: 2 } }, text);
    const action = copy && h(TapCopy, { copy, onDone: () => seen(p) });
    if (images.length) {
      const some = images.slice(0, images.length > 5 ? 4 : 5);
      return h(Fragment, null,
        h('div', { style: { display: 'flex', gap: 6 } },
          ...some.map(({ f, k }) => h('button', { key: k, type: 'button', 'aria-label': `Open ${f.name}`, onClick: () => { setViewing(k); seen(p); }, style: { ...tapIcon, width: 52, height: 52 } }, thumb(f, 52))),
          images.length > some.length && h('button', { type: 'button', 'aria-label': `${images.length - some.length} more images`, onClick: onOpen, style: { ...tapIcon, width: 52, height: 52, border: '1px solid var(--color-border)', fontSize: rem(13), fontWeight: 600 } }, `+${images.length - some.length}`)),
        viewing !== null && h(ui.FileViewer, { files: viewerOf(p.files), index: viewing, onClose: () => setViewing(null) }));
    }
    if (p.secret || kind === 'secret') {
      const text = p.secret ? p.secret.id : secretExpired(p) ? 'This secret expired' : maskSecret(p.text);
      return h('div', { style: box }, h('span', { style: { ...code, flex: 1, ...oneLine } }, text), action);
    }
    if (kind === 'command') {
      const lines = String(copy ? copy.text : '').split('\n').filter(Boolean);
      return h('div', { style: { ...box, background: 'var(--color-terminal)' } },
        h('span', { style: { ...code, flex: 1, ...oneLine } }, lines[0]),
        lines.length > 1 && h('span', { style: metaFont }, `+${lines.length - 1}`), action);
    }
    const url = kind === 'link' ? httpUrl(p.url || p.text) : null;
    if (url) {
      return h('div', { style: box },
        h('span', { style: { ...code, flex: 1, color: 'var(--color-link)', ...oneLine } }, url.href),
        h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open link', onClick: () => seen(p), style: tapIcon }, h(I('arrow-square-out'), { size: 18 })));
    }
    if (kind === 'steps') {
      const steps = p.steps || [];
      return h('button', { type: 'button', onClick: onOpen, style: tapOpen },
        ...steps.slice(0, 2).map((s, i) => h('div', { key: i, style: { fontSize: rem(12.5), lineHeight: 1.45, color: 'var(--color-text-primary)', ...oneLine } }, `${i + 1}. ${s.text}`)),
        steps.length > 2 && more(`Show more (${steps.length - 2})`));
    }
    if (p.text) {
      return h('div', { style: { ...box, alignItems: 'flex-start', padding: '6px 0 6px 10px' } },
        h('button', { type: 'button', onClick: onOpen, style: { ...tapOpen, flex: 1, minWidth: 0 } },
          h('div', { style: { ...code, whiteSpace: 'pre-wrap', ...clamp(3) } }, p.text.replace(/\n{2,}/g, '\n')),
          more('Show more')),
        action);
    }
    const names = (p.files || []).map((f) => f.name);
    return names.length ? h('div', { style: { ...metaFont, ...oneLine } }, names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]) : null;
  }

  /**
   * One item of a list. Closed it is a 56px row, or a short card; open it is the same in both views:
   * the head, all of the content, Delete. `data-*` tells the kind and the state in both.
   */
  function Entry({ p, view, open, onToggle, meta, first, showProject }) {
    const ref = useRef(null);
    // Keeps the tapped item on screen when an item above it closes.
    useEffect(() => {
      const el = ref.current;
      if (!open || !el || !el.scrollIntoView) return;
      const r = el.getBoundingClientRect();
      if (r.top < 110 || r.top > window.innerHeight * 0.55) el.scrollIntoView({ block: 'start' });
    }, [open]);
    const card = view === 'cards';
    const marks = { ref, 'data-testid': p.secret ? 'sent-secret' : 'preview-item', 'data-kind': kindFor(p), 'data-state': p.secret ? p.secret.state : undefined, 'data-unseen': !p.seenAt ? 'true' : undefined, 'data-open': open ? 'true' : undefined };
    const outer = card
      ? { ...frame, background: open ? 'var(--color-pane)' : 'var(--color-elevated)', scrollMarginTop: 40 }
      : { borderTop: first ? 'none' : '1px solid var(--color-border)', background: open ? 'var(--color-pane)' : 'transparent', scrollMarginTop: 40 };
    return h('div', { ...marks, style: outer },
      h('div', { style: { display: 'flex', alignItems: open ? 'flex-start' : 'center', gap: 4, paddingRight: 4 } },
        h(Head, { p, open, meta, onToggle }),
        open ? h('button', { type: 'button', 'aria-label': 'Close', onClick: onToggle, style: tapIcon }, h(icons.x, { size: 16 }))
          : !card && h(QuickAction, { p, kind: kindFor(p) })),
      !open && card && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 10px 10px' } },
        p.note && h('div', { onClick: onToggle, style: { fontSize: rem(12.5), lineHeight: 1.4, color: 'var(--color-text-secondary)', cursor: 'pointer', ...clamp(2) } }, p.note),
        h(Peek, { p, onOpen: onToggle })),
      open && h('div', { style: { padding: '2px 10px 6px' } }, h(FullItem, { p, showProject })));
  }

  /** A list by day. `sticky`: the day stays at the top while its items scroll (the history). */
  function ItemList({ items, showProject, inThread, sticky }) {
    const view = usePv((s) => s.view);
    const projects = useProjects();
    const [openId, setOpenId] = useState(null);
    const toggle = (p) => { setOpenId((cur) => (cur === p.id ? null : p.id)); seen(p); };
    const metaOf = (p) => {
      const project = projects.find((x) => x.id === p.sessionId);
      const name = project ? project.name : p.sessionName;
      const place = inThread ? [KIND[kindFor(p)].label] : [showProject ? name : null, p.terminalLabel];
      // A sent secret says its state on the closed item too.
      const state = p.secret ? (SECRET_STATE[p.secret.state] || SECRET_STATE.expired).label : null;
      return [state, ...place].filter(Boolean).join(' · ') || name || '';
    };
    const groups = [];
    for (const p of items) { const day = dayOf(p.createdAt); const g = groups[groups.length - 1]; if (g && g.day === day) g.items.push(p); else groups.push({ day, items: [p] }); }
    const entry = (p, i) => h(Entry, { key: p.id, p, view, first: i === 0, open: openId === p.id, onToggle: () => toggle(p), meta: metaOf(p), showProject });
    return h('div', { 'data-testid': 'inbox-list', 'data-view': view },
      // Touch screens: every button and link in an open item is at least 44px.
      h('style', null, '@media (pointer: coarse) { [data-inbox-body] button, [data-inbox-body] a[aria-label] { min-height: 44px !important; min-width: 44px; } }'),
      ...groups.map((g) => h('section', { key: g.day },
        h('h2', { style: { margin: 0, padding: '8px 2px 4px', font: `600 ${rem(10.5)} var(--font-mono)`, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', ...(sticky ? { position: 'sticky', top: 0, zIndex: 3, background: 'var(--color-base)' } : {}) } }, g.day),
        // No overflow clip on the frame: it would stop the sticky day and scrollIntoView.
        h('div', { style: view === 'cards' ? { display: 'flex', flexDirection: 'column', gap: 8 } : frame }, ...g.items.map(entry)))));
  }

  /** Rows or Cards: two 44px buttons that act as one choice. */
  function ViewToggle() {
    const view = usePv((s) => s.view);
    const option = (value, label, icon, edge) => {
      const on = view === value;
      return h('button', { type: 'button', role: 'radio', 'aria-checked': on, 'aria-label': label, title: label, onClick: () => { if (!on) void usePv.getState().setView(value); },
        style: { ...tapIcon, borderRadius: edge, background: on ? 'var(--color-hover)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' } },
        h(I(icon), { size: 18, weight: on ? 'bold' : 'regular' }));
    };
    return h('div', { role: 'radiogroup', 'aria-label': 'View', style: { display: 'flex', flexShrink: 0, outline: '1px solid var(--color-border-strong)', outlineOffset: -1, borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)' } },
      option('rows', 'Rows', 'rows', 'var(--radius-md) 0 0 var(--radius-md)'),
      option('cards', 'Cards', 'cards', '0 var(--radius-md) var(--radius-md) 0'));
  }

  // ── the project's previews in a bottom sheet (phone and desktop) ─────────────────────────
  // Load on open; mark seen on CLOSE, not open, so the unviewed dots show while you look.
  function Sheet() {
    const sessionId = usePv((s) => s.sheet);
    const items = useAllItems();
    const [sending, setSending] = useState(false);
    const loaded = usePv((s) => s.loaded);
    const project = useProjects().find((x) => x.id === sessionId);
    const projectName = project ? project.name : null;
    useEffect(() => {
      if (!sessionId) return;
      void usePv.getState().load();
      return () => { void usePv.getState().markAllSeen(sessionId); };
    }, [sessionId]);
    // The same page of 20 as the history (2026-11-09): every card at once crashed the page on an iPhone.
    // Hooks stay above the early return, so their order never changes.
    const [shown, setShown] = useState(PAGE);
    useEffect(() => { setShown(PAGE); setSending(false); }, [sessionId]);
    if (!sessionId) return null;
    const mine = items.filter((p) => p.sessionId === sessionId);
    return h(ui.Modal, { open: true, sheet: true, title: projectName ? `${NAME} · ${projectName}` : NAME, onClose: () => usePv.getState().closeSheet() },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 6 } },
        h('div', { style: row }, h(SendSecretButton, { onClick: () => setSending(true) })),
        sending && h(SendSecret, { sessionId, onClose: () => setSending(false) }),
        mine.length === 0 && h(EmptyState, { loading: !loaded, title: 'Nothing here yet', body: 'Threads in this project put commands, links, files and text here for you.' }),
        mine.length > 0 && h(ItemList, { items: mine.slice(0, shown), showProject: false }),
        mine.length > shown && h('button', { type: 'button', onClick: () => setShown((n) => n + PAGE),
          style: { alignSelf: 'center', height: 34, padding: '0 16px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: rem(13), fontWeight: 500, cursor: 'pointer' } },
          `Show older (${mine.length - shown} more)`)));
  }

  // ── the history across projects (the rail view), grouped by day ──────────────────────────
  function History() {
    const all = useAllItems();
    const [sending, setSending] = useState(false);
    const loaded = usePv((s) => s.loaded);
    const sessions = useProjects();
    const [project, setProject] = useState('');
    const [thread, setThread] = useState('');
    const [query, setQuery] = useState('');
    useEffect(() => { void usePv.getState().load(); return () => { void usePv.getState().markAllSeen(); }; }, []);
    const nameOf = (id) => (sessions.find((x) => x.id === id) || {}).name;
    const projects = useMemo(() => projectsWithPreviews(all, nameOf), [all, sessions]);
    const threads = useMemo(() => threadsWithPreviews(all, project || null), [all, project]);
    // A thread from another project stops applying when the project changes.
    useEffect(() => { if (thread && !threads.some((t) => t.id === thread)) setThread(''); }, [threads, thread]);
    const items = useMemo(() => filterPreviews(all, { project: project || null, thread: thread || null, query }, nameOf), [all, project, thread, query, sessions]);
    // The filters are the app's FilterBar (2026-11-07): Project and Thread in its panel, the picks as
    // pills under the row. The search (1.3.0) is behind a magnifying glass: open, it has the row with
    // Cancel and Filters. Cancel and Escape clear it, so a closed search never hides an item.
    const [searching, setSearching] = useState(false);
    const magnifier = useRef(null);
    const wasSearching = useRef(false);
    useEffect(() => {
      if (!searching && wasSearching.current && magnifier.current) magnifier.current.focus();
      wasSearching.current = searching;
    }, [searching]);
    const closeSearch = () => { setSearching(false); setQuery(''); };
    const facets = [
      { id: 'project', title: 'Project', allLabel: 'All projects', value: project || null, onChange: (v) => setProject(v || ''),
        options: projects.map((p) => ({ value: p.id, label: p.name, count: p.count })) },
      { id: 'thread', title: 'Thread', allLabel: 'All threads', value: thread || null, onChange: (v) => setThread(v || ''),
        options: threads.map((t) => ({ value: t.id, label: t.label, count: t.count })) },
    ];
    // A page of 20 at a time (2026-11-09): with every card at once, 74 previews crashed the page on an iPhone.
    const [shown, setShown] = useState(PAGE);
    useEffect(() => { setShown(PAGE); }, [project, thread, query]);
    const visible = useMemo(() => items.slice(0, shown), [items, shown]);
    // One row on a 390px phone: the magnifying glass, Filters, the view toggle, Send Secret. No title and
    // no description: the app's own header names the screen.
    const bar = { compact: true, facets, doneLabel: `Show ${items.length} ${items.length === 1 ? ONE : MANY}` };
    return h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 clamp(12px, 4vw, 26px) 24px' } },
      h('div', { style: { maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column' } },
        h('div', { role: 'search', style: { padding: '8px 0 2px' },
          // Escape in the field only: the Filters panel and the viewer have their own Escape.
          onKeyDown: (e) => { if (e.key === 'Escape' && e.target.getAttribute('aria-label') === `Search ${MANY}`) { e.preventDefault(); closeSearch(); } } },
          h(ui.FilterBar, searching
            ? { ...bar, autoFocus: true, query, onQueryChange: setQuery, placeholder: `Search ${MANY}`,
              trailing: h('button', { type: 'button', 'aria-label': 'Cancel search', title: 'Cancel search', onClick: closeSearch, style: { ...chip, height: 44, border: 'none', background: 'transparent', padding: '0 4px', color: 'var(--color-link)', fontWeight: 600, flexShrink: 0 } }, 'Cancel') }
            : { ...bar,
              leading: h('button', { ref: magnifier, type: 'button', 'aria-label': `Search ${MANY}`, title: `Search ${MANY}`, onClick: () => setSearching(true), style: { ...tapIcon, border: '1px solid var(--color-border-strong)', background: 'var(--color-elevated)' } }, h(I('search'), { size: 18 })),
              trailing: h(Fragment, null, h(ViewToggle), h(SendSecretButton, { onClick: () => setSending(true), style: { marginLeft: 'auto' } })) })),
        sending && h(SendSecret, { sessionId: project || null, onClose: () => setSending(false) }),
        all.length === 0 && h(EmptyState, { loading: !loaded, title: `Your ${NAME} is empty`, body: 'Ask a thread to send you a command, a link, a screenshot or a page. It lands here.' }),
        all.length > 0 && items.length === 0 && h('div', { style: { fontSize: rem(13.5), color: 'var(--color-text-tertiary)', padding: '12px 0' } }, `No ${ONE} matches.`),
        items.length > 0 && h(ItemList, { items: visible, showProject: true, sticky: true }),
        items.length > shown && h('button', { type: 'button', onClick: () => setShown((n) => n + PAGE), style: { ...chip, alignSelf: 'center', height: 44, marginTop: 10 } },
          `Show older (${items.length - shown} more)`)));
  }

  // ── the right-column tab (desktop, 2026-11-09): the open thread's previews only ───────────
  function ThreadTab({ terminalId, sessionId }) {
    const all = useAllItems();
    const [sending, setSending] = useState(false);
    const threads = useThreads();
    const loaded = usePv((s) => s.loaded);
    useEffect(() => {
      void usePv.getState().load();
      if (!terminalId) return;
      return () => { for (const x of usePv.getState().items) if (!x.seenAt && x.terminalId === terminalId) void usePv.getState().markSeen(x.id); };
    }, [terminalId]);
    const mine = useMemo(() => (terminalId ? all.filter((p) => p.terminalId === terminalId) : []), [all, terminalId]);
    // The same page of 20 as the history and the sheet (2026-11-09, I8): on the phone this tab opens in
    // a sheet, and a daemon with no thumbnails (WSL2 has no sips) serves every picture at full size.
    // Every hook is above the returns, so their order never changes.
    // The count belongs to one thread: another thread starts at its first page, in its first render
    // (the effect alone would render the longer list of the thread before once).
    const [page, setPage] = useState({ id: terminalId, shown: PAGE });
    useEffect(() => { setPage({ id: terminalId, shown: PAGE }); }, [terminalId]);
    const shown = page.id === terminalId ? page.shown : PAGE;
    const visible = useMemo(() => mine.slice(0, shown), [mine, shown]);
    if (!terminalId) return h('div', { style: { padding: 12 } }, h(EmptyState, { title: 'No thread open', body: `Open a thread to see its ${MANY}.` }));
    const thread = threads.find((t) => t.id === terminalId);
    const project = sessionId || (thread ? thread.projectId : null);
    return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
      project && h('div', { style: row }, h(SendSecretButton, { onClick: () => setSending(true) })),
      sending && project && h(SendSecret, { sessionId: project, terminalId, terminalLabel: thread ? thread.label : null, onClose: () => setSending(false) }),
      mine.length === 0 && h(EmptyState, { loading: !loaded, title: `No ${MANY} from this thread yet`, body: 'When this thread sends you a command, a link, a file or a screenshot, it shows here.' }),
      mine.length > 0 && h(ItemList, { items: visible, showProject: false, inThread: true }),
      mine.length > shown && h('button', { type: 'button', onClick: () => setPage({ id: terminalId, shown: shown + PAGE }),
        style: { alignSelf: 'center', height: 34, padding: '0 16px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: rem(13), fontWeight: 500, cursor: 'pointer' } },
        `Show older (${mine.length - shown} more)`));
  }

  // ── the header eye: the project's unseen count, opens the sheet ──────────────────────────
  function Eye({ sessionId, floating }) {
    const n = usePv((s) => unseenOf(s.items, sessionId));
    if (!sessionId) return null;
    const box = floating
      ? { borderRadius: 'var(--radius-lg)', background: 'color-mix(in srgb, var(--color-pane) 55%, transparent)', border: '1px solid color-mix(in srgb, var(--color-text-emphasis) 10%, transparent)', height: 30, width: 32 }
      : { borderRadius: 'var(--radius-md)', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', height: 36, width: 36 };
    return h('button', { type: 'button', 'aria-label': NAME, title: n ? `${n} new ${MANY}` : NAME, onClick: () => usePv.getState().openSheet(sessionId),
      style: { ...box, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', color: n ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 } },
      h(icons.tray, { size: 20 }),
      n > 0 && h('span', { 'aria-label': `${n} new ${MANY}`, style: { position: 'absolute', top: -5, right: -5, minWidth: 17, height: 17, padding: '0 5px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: `700 ${rem(10.5)} var(--font-sans)`, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, n > 99 ? '99+' : n));
  }
  const ProjectEye = ({ session }) => h(Eye, { sessionId: session ? session.id : null });
  // No thread header button (2026-11-07): a thread reaches its previews from the shelf and the thread menu.

  d.register({
    views: [{ id: 'history', label: NAME, icon: 'tray', Component: History }],
    // The badge (v4.5.2): this thread's new previews. It puts the dot on the thread's ⋯ button and a
    // count on the tab and on the phone's menu row (the thread-menu item that did it left in v4.5.0).
    inspectorTabs: [{ id: 'thread', label: NAME, icon: 'tray', Component: ThreadTab,
      badge: { subscribe: (cb) => usePv.subscribe(cb), get: ({ terminalId }) => usePv.getState().items.reduce((n, x) => n + (!x.seenAt && x.terminalId === terminalId ? 1 : 0), 0) } }],
    projectMenu: [{ id: 'open', label: NAME, onPick: ({ session }) => usePv.getState().openSheet(session.id) }],
    // No thread-menu item (2026-11-09): a thread shows its own previews (the Previews tab, a row in the
    // phone's thread menu), a project shows the project's (its menu and the eye), and the Previews
    // screen shows all of them with the Project and Thread filters.
    slots: [
      { id: 'project-eye', slot: 'project.header.actions', Component: ProjectEye },
      { id: 'sheet', slot: 'app.overlay', Component: Sheet },
    ],
  });
}
