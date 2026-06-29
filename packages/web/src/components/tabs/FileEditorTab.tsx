import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdown } from '../../lib/markdown';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';
import { isMarkdown, languageFor } from '../../lib/fileType';

// Remember each file tab's rendered-markdown scroll position across tab switches
// (TabHost unmounts the inactive tab, so the DOM scrollTop would otherwise reset to 0).
// Keyed by terminal id; in-memory for the session.
const mdScroll = new Map<string, number>();

export function FileEditorTab({ terminal }: { terminal: Terminal }) {
  const path = (terminal.config?.path as string) || terminal.label;
  const md = isMarkdown(path);
  const host = useRef<HTMLDivElement>(null);
  const mdView = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<'edit' | 'view'>(md ? 'view' : 'edit');

  // Restore the saved scroll position once the markdown HTML is in the DOM (so
  // scrollHeight is measured). useLayoutEffect → set before paint, no flash. Re-runs
  // when content loads or the view is (re)shown; it never fights live scrolling
  // because onScroll only writes the map, it doesn't change content.
  useLayoutEffect(() => {
    if (!(md && mode === 'view')) return;
    const el = mdView.current;
    const saved = mdScroll.get(terminal.id);
    if (el && saved != null) el.scrollTop = saved;
  }, [md, mode, content, loaded, terminal.id]);

  useEffect(() => {
    let on = true;
    setLoaded(false);
    api.readFile(terminal.sessionId, path)
      .then((r) => { if (on) { setContent(r.content); setLoaded(true); } })
      .catch(() => { if (on) setLoaded(true); });
    return () => { on = false; };
  }, [terminal.sessionId, path]);

  // Mount CodeMirror in edit mode (and code files); recreate only on file/mode change, not per keystroke.
  useEffect(() => {
    if (mode !== 'edit' || !loaded || !host.current) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        oneDark,
        ...languageFor(path),
        EditorView.updateListener.of((u) => { if (u.docChanged) { setDirty(true); setContent(u.state.doc.toString()); } }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loaded, path]);

  const save = useCallback(async () => {
    const text = view.current ? view.current.state.doc.toString() : content;
    await api.writeFile(terminal.sessionId, path, text);
    setContent(text);
    setDirty(false);
  }, [terminal.sessionId, path, content]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const tab = (m: 'view' | 'edit') => (
    <button key={m} onClick={() => setMode(m)} style={{ padding: '3px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, textTransform: 'capitalize', background: mode === m ? 'var(--color-accent)' : 'transparent', color: mode === m ? '#08240F' : 'var(--color-text-secondary)', fontWeight: mode === m ? 600 : 400 }}>{m}</button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, background: 'var(--color-terminal)' }}>
      <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', background: 'var(--color-terminal)', borderBottom: '1px solid var(--color-border)', fontSize: 13 }}>
        <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
        {dirty && <span style={{ color: 'var(--color-status-yellow)', fontSize: 11 }}>● unsaved</span>}
        {md && (
          <div style={{ display: 'inline-flex', marginLeft: 6, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, padding: 2 }}>
            {tab('view')}{tab('edit')}
          </div>
        )}
        <button onClick={() => void save()} disabled={!dirty} style={{ marginLeft: 'auto', height: 26, padding: '0 12px', background: dirty ? 'var(--color-accent)' : 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: dirty ? '#08240F' : 'var(--color-text-secondary)', fontWeight: 600, fontSize: 12 }}>Save</button>
      </div>
      {md && mode === 'view'
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
