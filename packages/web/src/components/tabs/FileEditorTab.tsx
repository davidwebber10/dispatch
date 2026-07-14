import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdown } from '../../lib/markdown';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { isCsv, isMarkdown, languageFor } from '../../lib/fileType';
import { CsvGrid } from './CsvGrid';
import { useTabs } from '../../stores/tabs';
import { clearDraft, getDraft, hasDraft, setDraft } from '../../lib/fileDrafts';

// Across tab switches (TabHost unmounts the inactive tab) we keep, in-memory for the
// session: each tab's rendered-markdown scroll position (by terminal id) and each file's
// content (by session+path) — so a re-opened tab renders FULLY on the first paint with no
// refetch flash, and the saved scroll restores against the full content immediately.
const mdScroll = new Map<string, number>();
const fileCache = new Map<string, string>();
const fileKey = (sessionId: string, path: string) => `${sessionId}\u001f${path}`;

export function FileEditorTab({ terminal }: { terminal: Terminal }) {
  const path = (terminal.config?.path as string) || terminal.label;
  const md = isMarkdown(path);
  const csv = isCsv(path);
  const rich = md || csv;              // has a second, non-CodeMirror view
  const ck = fileKey(terminal.sessionId, path);
  const host = useRef<HTMLDivElement>(null);
  const mdView = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Seed from the DRAFT first, then the cache: TabHost unmounts inactive tabs, so an unsaved
  // edit only survives a tab switch because it lives in fileDrafts (see that module). A draft
  // outranks both the cache and the file on disk — it is the user's work. Falling back to the
  // cache means a re-opened clean tab renders its content + restores scroll on the first paint,
  // with no empty "loading" window in between.
  const [content, setContent] = useState(() => getDraft(terminal.id) ?? fileCache.get(ck) ?? '');
  const [dirty, setDirty] = useState(() => hasDraft(terminal.id));
  const [loaded, setLoaded] = useState(() => hasDraft(terminal.id) || fileCache.has(ck));
  const [mode, setMode] = useState<'edit' | 'view'>(rich ? 'view' : 'edit');

  // The one funnel for every edit, from every view (CodeMirror + CsvGrid), so the two paths
  // cannot drift: state for this render, draft so the edit survives unmount, dirty for the UI
  // and the close guard.
  const applyEdit = useCallback((next: string) => {
    setContent(next);
    setDraft(terminal.id, next);
    setDirty(true);
  }, [terminal.id]);

  // Restore the saved scroll position once the markdown HTML is in the DOM. useLayoutEffect
  // → set before paint (no flash); the rAF retry re-applies after late layout (images, code
  // highlighting) grows the height. `apply` reads the map fresh, so it never clobbers a
  // scroll the user just performed.
  useLayoutEffect(() => {
    if (!(md && mode === 'view')) return;
    const apply = () => {
      const el = mdView.current;
      const saved = mdScroll.get(terminal.id);
      if (el && saved != null) el.scrollTop = saved;
    };
    apply();
    const raf = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(raf);
  }, [md, mode, content, loaded, terminal.id]);

  useEffect(() => {
    // An unsaved draft outranks the file on disk. Without this early return, coming back to a
    // tab you edited would refetch the server's copy straight over the top of your work.
    if (hasDraft(terminal.id)) { setLoaded(true); return; }
    let on = true;
    if (!fileCache.has(ck)) setLoaded(false); // only show the empty state when nothing is cached
    api.readFile(terminal.sessionId, path)
      .then((r) => { if (on) { fileCache.set(ck, r.content); setContent(r.content); setLoaded(true); } })
      .catch(() => { if (on) setLoaded(true); });
    return () => { on = false; };
  }, [terminal.sessionId, terminal.id, path, ck]);

  // Mount CodeMirror in edit mode (and code files); recreate only on file/mode change, not per keystroke.
  useEffect(() => {
    if (mode !== 'edit' || !loaded || !host.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        ...languageFor(path),
        EditorView.updateListener.of((u) => { if (u.docChanged) applyEdit(u.state.doc.toString()); }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loaded, path]);

  const save = useCallback(async () => {
    const text = view.current ? view.current.state.doc.toString() : content;
    // If the write throws we fall out here WITHOUT clearing the draft — a failed save must
    // never be the thing that loses the user's edit.
    await api.writeFile(terminal.sessionId, path, text);
    fileCache.set(ck, text);
    clearDraft(terminal.id);   // saved: what's on disk is now the truth again
    setContent(text);
    setDirty(false);
  }, [terminal.sessionId, terminal.id, path, content, ck]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  // Publish dirtiness to the tabs store — closeTab() reads it to guard the close button.
  // Deliberately NO unmount cleanup: TabHost unmounts a tab merely because it went to the
  // BACKGROUND, and clearing the flag there would wipe the dirty record of a still-open tab —
  // its × in the tab bar would then close it with no prompt. The flag is cleared by save
  // (dirty→false re-runs this effect) and by closeTab (the tab is actually going away).
  useEffect(() => {
    useTabs.getState().setTabDirty(terminal.id, dirty);
  }, [terminal.id, dirty]);

  // markdown reads "view | edit"; a CSV reads "table | raw" — same two modes underneath.
  const label = (m: 'view' | 'edit') => (csv ? (m === 'view' ? 'table' : 'raw') : m);
  const tab = (m: 'view' | 'edit') => (
    <button key={m} onClick={() => setMode(m)} style={{ padding: '3px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, textTransform: 'capitalize', background: mode === m ? 'var(--color-accent)' : 'transparent', color: mode === m ? '#08240F' : 'var(--color-text-secondary)', fontWeight: mode === m ? 600 : 400 }}>{label(m)}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-terminal)' }}>
      <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: 'var(--color-terminal)', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
        <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
        {dirty && <span style={{ color: 'var(--color-status-yellow)', fontSize: 11 }}>● unsaved</span>}
        {rich && (
          <div style={{ display: 'inline-flex', marginLeft: 6, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, padding: 2 }}>
            {tab('view')}{tab('edit')}
          </div>
        )}
        <button onClick={() => void save()} disabled={!dirty} style={{ marginLeft: 'auto', height: 26, padding: '0 12px', background: dirty ? 'var(--color-accent)' : 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: dirty ? '#08240F' : 'var(--color-text-secondary)', fontWeight: 600, fontSize: 12 }}>Save</button>
      </div>
      {csv && mode === 'view'
        ? <CsvGrid content={content} path={path} onChange={applyEdit} />
        : md && mode === 'view'
          ? <div
              ref={mdView}
              className="md-view"
              onScroll={(e) => mdScroll.set(terminal.id, e.currentTarget.scrollTop)}
              style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 28px' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          : <div ref={host} style={{ flex: 1, minHeight: 0, overflow: 'auto' }} />}
    </div>
  );
}
