// Composer favorites: a row of your own buttons above every composer, edited in Settings.
// A button holds a message of any length and one of three actions: send it at once, add it to
// what is typed, or replace what is typed. The row slides sideways when the buttons do not fit.
// Shows a plugin changing an existing screen (the composer) through its actions row.
//
// Settings is one list: drag a row by its handle to move it, tap a row to open it and change it.
// Each change is saved at once.
// SDK version 2 (plugin.json says "sdk": 2): `d` is bound to this plugin, so no call names the plugin id.
export default function activate(d) {
  const { h, hooks: { useState, useEffect, useRef, useDoc }, ui, icons, docs } = d;

  const MODES = [
    { value: 'send', label: 'Send now', hint: 'A tap sends the message at once. Text you typed first goes above it.' },
    { value: 'insert', label: 'Add', hint: 'A tap adds the message to what you typed. You send it.' },
    { value: 'replace', label: 'Replace', hint: 'A tap replaces what you typed with the message. You send it.' },
  ];
  const modeLabel = (mode) => (MODES.find((m) => m.value === mode) || MODES[1]).label;
  const DEFAULTS = [
    { id: 'summarize', label: 'Summarize', mode: 'send', text: 'Summarize where you are in one short paragraph, then list what is left.' },
    { id: 'continue', label: 'Continue', mode: 'send', text: 'Continue with the next step. Do not stop to ask unless you need a decision from me.' },
    { id: 'tests', label: 'Run tests', mode: 'send', text: 'Run the test suite and report only the failures.' },
    { id: 'review', label: 'Review', mode: 'send', text: 'Review your own change as a strict reviewer would. List each bug, each risk and each missing test, the most serious first. Do not change anything yet.' },
    { id: 'commit', label: 'Commit & push', mode: 'send', text: 'Commit what is done with a clear message and push the branch.' },
    { id: 'pr', label: 'Open PR', mode: 'send', text: 'Open a pull request for this branch. Write a short description: what changed, why, and how you tested it. Do not merge it.' },
    { id: 'explain', label: 'Explain', mode: 'send', text: 'Explain your last change to me as if I had not read the code.' },
    { id: 'plan', label: 'Plan first', mode: 'insert', text: 'Before you change anything, give me a short plan and wait for my go.' },
  ];
  const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // A list saved by version 0.1.0 has no id and no action: those buttons keep what they did (add).
  const normalize = (list) => (Array.isArray(list) ? list : DEFAULTS).map((f, i) => ({
    id: f.id || `fav-${i}`, label: String(f.label ?? ''), text: String(f.text ?? ''),
    mode: MODES.some((m) => m.value === f.mode) ? f.mode : 'insert',
  }));
  // A button with no name or no message stays in Settings and does not show above the composer.
  const complete = (f) => !!(f.label.trim() && f.text.trim());
  const blank = (f) => !f.label.trim() && !f.text.trim();
  const missing = (f) => (!f.label.trim() ? 'Needs a name' : !f.text.trim() ? 'Needs a message' : '');

  // `{draft}` in a message is the place for what is typed: "Research {draft} and name your sources."
  const DRAFT = '{draft}';
  const run = (f, ctx) => {
    const typed = ctx.value.trim();
    // An app before Dispatch 4.15.0 has no `send`: the message is put in the composer instead.
    const send = (text) => (typeof ctx.send === 'function' ? ctx.send(text) : ctx.set(text));
    if (f.text.includes(DRAFT)) {
      const text = f.text.split(DRAFT).join(typed);
      return f.mode === 'send' ? send(text) : ctx.set(text);
    }
    if (f.mode === 'replace') return ctx.set(f.text);
    if (f.mode === 'send') return send(typed ? `${ctx.value.trimEnd()}\n\n${f.text}` : f.text);
    return typed ? ctx.insert(f.text) : ctx.set(f.text);
  };

  // The list lives on the daemon; register again after a change so the composer shows the new buttons.
  const register = (favorites) => d.register({
    composerActions: favorites.filter(complete).map((f) => {
      const fav = { ...f, label: f.label.trim(), text: f.text.trim() };
      return { id: fav.id, label: fav.label, onClick: (ctx) => run(fav, ctx) };
    }),
    settings: [{ id: 'favorites', label: 'Composer favorites', blurb: 'The buttons above the composer', icon: 'star', Component: Settings }],
  });

  const HAIRLINE = '1px solid var(--color-border)';
  const small = { fontSize: '0.78125rem', color: 'var(--color-text-tertiary)', lineHeight: 1.45 };
  const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
  // The list is one card; a hairline splits its rows.
  const group = { background: 'var(--color-pane)', border: HAIRLINE, borderRadius: 'var(--radius-md, 10px)', overflow: 'hidden' };
  // The card clips what goes past its edge, so the focus ring of a row is drawn inside the row.
  const inset = { outlineOffset: -2 };
  const field = { ...ui.styles.fieldInput, width: '100%', boxSizing: 'border-box', fontSize: '1rem' };
  const fieldLabel = { ...small, display: 'flex', flexDirection: 'column', gap: 5 };
  const quiet = { ...ui.styles.ghostBtn, height: 34, border: 'none', background: 'transparent' };
  const iconText = (name, text) => {
    const Icon = icons[name];
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, Icon && h(Icon, { size: 14 }), text);
  };
  // The open row and the Undo line outlive a new mount of the screen (an app before 4.15.0 mounts
  // the screen again after each change).
  const view = { open: null, undo: null };

  // One row, closed: the grip, the name and the start of the message, what a tap does.
  function Head({ f, open, handle, onToggle }) {
    const Grip = icons.grip || icons.dots;
    const Caret = open ? icons['caret-down'] : icons['caret-right'];
    const name = f.label.trim() || 'New button';
    const note = missing(f);
    const { style: gripStyle, ...grip } = handle || {};
    return h('div', { style: { display: 'flex', alignItems: 'stretch', minHeight: 56 } },
      handle && Grip && h('span', {
        ...grip, 'data-testid': 'favorite-grip', 'aria-label': `Move ${name}`, title: 'Drag to move',
        style: { ...gripStyle, ...inset, flex: 'none', width: 40, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-tertiary)' },
      }, h(Grip, { size: 18, weight: 'bold' })),
      h('button', {
        type: 'button', 'aria-expanded': open, 'data-testid': 'favorite-head', onClick: onToggle,
        style: { ...inset, flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10, padding: handle ? '9px 12px 9px 0' : '9px 12px 9px 14px', background: 'transparent', border: 'none', textAlign: 'left', color: 'inherit', font: 'inherit', cursor: 'pointer' },
      },
        h('span', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('span', { 'data-testid': 'favorite-name', style: { ...ellipsis, fontSize: '0.9375rem', fontWeight: 600, color: f.label.trim() ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' } }, name),
          !open && h('span', { style: { ...small, ...ellipsis, color: note ? 'var(--color-status-amber, var(--color-text-secondary))' : small.color } }, note ? `${note}. It does not show above the composer yet.` : f.text.trim().replace(/\s+/g, ' '))),
        !open && h('span', { 'data-testid': 'favorite-mode', style: { ...small, flex: 'none' } }, modeLabel(f.mode)),
        Caret && h('span', { 'aria-hidden': true, style: { flex: 'none', display: 'inline-flex', color: 'var(--color-text-tertiary)' } }, h(Caret, { size: 16 }))));
  }

  // One row, open: the fields.
  function Editor({ f, n, count, onChange, onFlush, onRemove, onMove, onDone }) {
    return h('div', { 'data-testid': 'favorite-editor', style: { display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 12px 12px' } },
      h('label', { style: fieldLabel }, 'Name',
        h('input', { value: f.label, maxLength: 28, placeholder: 'Run tests', 'aria-label': `Name of button ${n}`, autoFocus: blank(f), onChange: (e) => onChange({ label: e.target.value }), onBlur: onFlush, style: { ...field, height: 38 } })),
      h('label', { style: fieldLabel }, 'Message',
        h('textarea', { value: f.text, rows: 4, placeholder: 'What the button says for you. It can be many lines.', 'aria-label': `Message of button ${n}`, onChange: (e) => onChange({ text: e.target.value }), onBlur: onFlush, style: { ...field, height: 'auto', padding: 9, lineHeight: 1.5, resize: 'vertical' } }),
        h('span', null, 'Write ', h('code', null, DRAFT), ' where the text you typed must go.')),
      h('div', { style: fieldLabel }, 'When you tap it',
        h(ui.Segmented, { value: f.mode, options: MODES, ariaLabel: `Action of button ${n}`, onChange: (mode) => onChange({ mode }, true) })),
      h('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', marginLeft: -8 } },
        h('button', { type: 'button', style: { ...quiet, color: 'var(--color-status-red)' }, onClick: onRemove }, iconText('trash', 'Remove')),
        // An app with no drag list (before Dispatch 4.15.0) moves a row with these.
        !ui.SortableList && h('button', { type: 'button', style: quiet, disabled: n === 1, onClick: () => onMove(-1) }, iconText('arrow-up', 'Move up')),
        !ui.SortableList && h('button', { type: 'button', style: quiet, disabled: n === count, onClick: () => onMove(1) }, iconText('arrow-down', 'Move down')),
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', style: { ...ui.styles.solidBtn(true), height: 34 }, onClick: onDone }, 'Done')));
  }

  function Settings() {
    const [saved, setSaved] = useDoc('favorites', DEFAULTS);
    // The list as edited here. Typing changes it; a write to the daemon follows at the end of an edit.
    const [local, setLocal] = useState(null);
    const [open, setOpenState] = useState(view.open);
    const [undo, setUndoState] = useState(view.undo);
    const list = local ?? normalize(saved);
    const unsaved = useRef(null);
    const setOpen = (id) => { view.open = id; setOpenState(id); };
    const setUndo = (u) => { view.undo = u; setUndoState(u); };

    // What the daemon has, as text: a write that would change nothing is not made.
    const written = useRef(null);
    // A row with no name and no message shows here while it is open, and is never written.
    const write = async (next) => {
      unsaved.current = null;
      setLocal(next);
      const keep = next.filter((f) => !blank(f));
      const body = JSON.stringify(keep);
      if (body === (written.current ?? JSON.stringify(normalize(saved)))) return;
      written.current = body;
      register(keep);
      try { await setSaved(keep); } catch { written.current = null; ui.hint('The favorites were not saved. Try again.'); }
    };
    const type = (next) => { unsaved.current = next; setLocal(next); };
    const flush = () => { if (unsaved.current) void write(unsaved.current); };
    // Leaving the screen in the middle of an edit still saves it. A row left with no name and no
    // message is not kept.
    useEffect(() => () => {
      if (!unsaved.current) return;
      const next = unsaved.current.filter((f) => !blank(f));
      unsaved.current = null;
      register(next); void docs.set('favorites', next);
    }, []);

    const change = (id, patch, now) => {
      const next = list.map((f) => (f.id === id ? { ...f, ...patch } : f));
      return now ? write(next) : type(next);
    };
    // Close the open row (and open another, if one is named). A row closed with nothing in it goes.
    const show = (id) => {
      const from = list.find((f) => f.id === open);
      const next = from && blank(from) && id !== open ? list.filter((f) => f.id !== open) : unsaved.current;
      setOpen(id);
      if (next) void write(next);
    };
    const toggle = (id) => show(open === id ? null : id);
    const reorder = (ids) => write(ids.map((id) => list.find((f) => f.id === id)).filter(Boolean));
    const move = (id, by) => {
      const from = list.findIndex((f) => f.id === id), to = from + by;
      if (from < 0 || to < 0 || to >= list.length) return;
      const next = list.slice();
      [next[from], next[to]] = [next[to], next[from]];
      void write(next);
    };
    const remove = (id) => {
      const f = list.find((x) => x.id === id);
      // Nothing to bring back from a row that was never filled in.
      setUndo(f && !blank(f) ? { list, text: `Removed "${f.label.trim() || 'New button'}".` } : null);
      setOpen(null);
      void write(list.filter((x) => x.id !== id));
    };
    // The new row is written when it has something in it.
    const add = () => {
      const f = { id: newId(), label: '', text: '', mode: 'send' };
      const kept = list.filter((x) => !(x.id === open && blank(x)));
      setUndo(null); setOpen(f.id);
      type([...kept, f]);
    };
    const restore = () => { setUndo({ list: list.filter((f) => !blank(f)), text: 'The defaults are back.' }); setOpen(null); void write(normalize(DEFAULTS)); };

    // `float`: the copy of the row that follows the finger, a card of its own.
    const row = (f, { dragging = false, handle, float = false } = {}) => {
      const isOpen = open === f.id && !dragging && !float;
      const n = list.findIndex((x) => x.id === f.id) + 1;
      const edge = float ? group : { borderTop: n > 1 ? HAIRLINE : 'none' };
      return h('div', { 'data-testid': 'favorite', style: edge },
        h(Head, { f, open: isOpen, handle: float ? {} : handle, onToggle: () => toggle(f.id) }),
        isOpen && h(Editor, {
          f, n, count: list.length, onFlush: flush,
          onChange: (patch, now) => change(f.id, patch, now),
          onRemove: () => remove(f.id), onMove: (by) => move(f.id, by), onDone: () => show(null),
        }));
    };

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h('span', { style: ui.styles.sectionLabel }, 'BUTTONS'),
      h('div', { style: small }, ui.SortableList
        ? 'They show above every composer, in this order. Drag a handle to move a button. Tap a button to change it.'
        : 'They show above every composer, in this order. Tap a button to change it or to move it.'),
      list.length === 0
        ? h('div', { style: { ...group, ...small, padding: '14px 12px' } }, 'No buttons. Add one, or restore the defaults.')
        : h('div', { style: group }, ui.SortableList
          ? h(ui.SortableList, { items: list, handle: true, onReorder: reorder, renderItem: (f, opts) => row(f, opts), renderOverlay: (f) => row(f, { float: true }) })
          : list.map((f) => h('div', { key: f.id }, row(f)))),
      undo && h('div', { role: 'status', 'data-testid': 'favorite-undo', style: { ...small, display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: '4px 4px 4px 12px', border: HAIRLINE, borderRadius: 'var(--radius-md, 10px)' } },
        undo.text,
        h('button', { type: 'button', style: { ...quiet, height: 30, color: 'var(--color-accent)', fontWeight: 600 }, onClick: () => { const back = undo.list; setUndo(null); void write(back); } }, 'Undo')),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        h('button', { type: 'button', style: { ...ui.styles.solidBtn(true), height: 34 }, onClick: add }, iconText('plus', 'Add a button')),
        h('span', { style: { flex: 1 } }),
        h('button', { type: 'button', style: { ...quiet, color: 'var(--color-text-tertiary)' }, onClick: restore }, 'Restore defaults')));
  }

  docs.get('favorites', DEFAULTS).then((list) => register(normalize(list)));
}
