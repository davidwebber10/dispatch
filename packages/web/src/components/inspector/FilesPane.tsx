import { useCallback, useEffect, useMemo, useState } from 'react';
import { CaretRight, DownloadSimple, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { FileEntry } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useSettings } from '../../stores/settings';
import { fileVisual } from '../common/typeIcons';
import { saveFileAs, saveFilesAs, type RemoteFile } from '../../lib/saveFiles';

const INDENT = 14;

const MENU_ITEM: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px',
  background: 'none', border: 'none', font: '400 13px var(--font-sans)', cursor: 'pointer',
  borderRadius: 6, textAlign: 'left',
};

/** Parent directory of a working-dir-relative path (or '.' for a top-level entry). */
function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(0, slash) : '.';
}

function homeAbbrev(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

/** Directories first, then name — the single ordering both the tree and Shift-ranges use. */
export function sortEntries(a: FileEntry, b: FileEntry): number {
  return Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name);
}

/**
 * The visible FILE rows in render order. This is the coordinate space a Shift-click range spans:
 * it must walk the tree exactly as renderDir does (same sort, only into expanded directories),
 * or "select everything between these two rows" would select rows the user can't see.
 */
export function flattenFiles(
  children: Record<string, FileEntry[]>,
  expanded: Set<string>,
  path = '.',
): string[] {
  const out: string[] = [];
  for (const e of (children[path] ?? []).slice().sort(sortEntries)) {
    if (e.isDirectory) {
      if (expanded.has(e.path)) out.push(...flattenFiles(children, expanded, e.path));
    } else {
      out.push(e.path);
    }
  }
  return out;
}

function Row({ children, style, onClick, onMiddle, onContext }: { children: React.ReactNode; style: React.CSSProperties; onClick: (e: React.MouseEvent) => void; onMiddle?: () => void; onContext?: (e: React.MouseEvent) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={onClick}
      onAuxClick={(e) => { if (e.button === 1 && onMiddle) { e.preventDefault(); onMiddle(); } }}
      onContextMenu={onContext}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...style, background: style.background ?? (hover ? 'rgba(255,255,255,0.04)' : 'transparent') }}>
      {children}
    </div>
  );
}

export function FilesPane({ projectId, onOpenFile }: { projectId: string | null; onOpenFile: (terminalId: string) => void }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId));
  const activeTabId = useTabs((s) => s.activeTabId);
  const tabsForProj = useTabs((s) => (projectId ? s.byProject[projectId] : undefined)) ?? [];
  const selectedPath = tabsForProj.find((t) => t.id === activeTabId && t.type === 'file')?.config?.path as string | undefined;
  const fs = useSettings((s) => s.sidebarFontSize);

  const loadDir = useCallback(async (path: string) => {
    if (!projectId) return;
    try {
      const entries = await api.listFiles(projectId, path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch { setChildren((prev) => ({ ...prev, [path]: [] })); }
  }, [projectId]);

  useEffect(() => {
    setChildren({}); setExpanded(new Set()); setSelected(new Set()); setAnchor(null);
    if (projectId) void loadDir('.');
  }, [projectId, loadDir]);

  // Dismiss the right-click menu on Escape (outside-click is handled by the backdrop).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  // Path → entry index, so the menu can show names rather than raw paths.
  const entryByPath = useMemo(() => {
    const m = new Map<string, FileEntry>();
    for (const list of Object.values(children)) for (const e of list) m.set(e.path, e);
    return m;
  }, [children]);

  async function saveAs(entry: FileEntry) {
    if (!projectId) return;
    try { await saveFileAs(api.downloadUrl(projectId, entry.path), entry.name); }
    catch { /* download/picker failed — nothing actionable to show in v1 */ }
  }

  async function renameEntry(entry: FileEntry) {
    if (!projectId) return;
    const next = window.prompt(`Rename "${entry.name}" to:`, entry.name);
    if (!next || next === entry.name) return;
    const slash = entry.path.lastIndexOf('/');
    const dir = slash >= 0 ? entry.path.slice(0, slash + 1) : '';
    try {
      await api.renameFile(projectId, entry.path, dir + next);
      await loadDir(parentDir(entry.path));
    } catch (err: any) { window.alert(`Rename failed: ${err?.message ?? err}`); }
  }

  async function deleteEntry(entry: FileEntry) {
    if (!projectId) return;
    if (!window.confirm(`Delete "${entry.name}"? This cannot be undone.`)) return;
    try {
      await api.deleteFile(projectId, entry.path);
      await loadDir(parentDir(entry.path));
    } catch (err: any) { window.alert(`Delete failed: ${err?.message ?? err}`); }
  }

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!children[path]) void loadDir(path); }
      return next;
    });
  }

  async function openFile(e: FileEntry, background = false) {
    if (!projectId) return;
    const existing = (useTabs.getState().byProject[projectId] ?? []).find((t) => t.type === 'file' && (t.config?.path as string) === e.path);
    if (existing) { background ? useTabs.getState().openTab(existing.id, true) : onOpenFile(existing.id); return; }
    const t = await api.createTerminal(projectId, { type: 'file', label: e.name, config: { path: e.path } });
    await useTabs.getState().loadTabs(projectId);
    if (background) useTabs.getState().openTab(t.id, true);
    else onOpenFile(t.id);
  }

  /** Finder semantics: plain click opens; Cmd/Ctrl toggles; Shift ranges. Files only. */
  function onRowClick(ev: React.MouseEvent, entry: FileEntry) {
    if (ev.metaKey || ev.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchor(entry.path);
      return;
    }
    if (ev.shiftKey && anchor) {
      const flat = flattenFiles(children, expanded);
      const i = flat.indexOf(anchor);
      const j = flat.indexOf(entry.path);
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        setSelected(new Set(flat.slice(lo, hi + 1)));
        return; // range-select does not open anything
      }
    }
    setSelected(new Set([entry.path]));
    setAnchor(entry.path);
    void openFile(entry);
  }

  /** Right-clicking inside the selection acts on all of it; outside it, collapse to that row. */
  function onRowContext(ev: React.MouseEvent, entry: FileEntry) {
    ev.preventDefault();
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
    }
    setMenu({ x: ev.clientX, y: ev.clientY, entry });
  }

  if (!projectId) return <div style={{ padding: 12, color: 'var(--color-text-tertiary)' }}>No project selected</div>;

  function renderDir(path: string, depth: number): React.ReactNode {
    const entries = (children[path] ?? []).slice().sort(sortEntries);
    return entries.map((e) => {
      const pl = 8 + depth * INDENT;
      if (e.isDirectory) {
        const isExp = expanded.has(e.path);
        return (
          <div key={e.path}>
            <Row onClick={() => toggle(e.path)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `6px 8px 6px ${pl}px`, borderRadius: 5, color: '#c9c9cf', cursor: 'pointer' }}>
              <CaretRight size={13} weight="bold" color="#8e8e96" style={{ flexShrink: 0, transition: 'transform 0.15s ease', transform: isExp ? 'rotate(90deg)' : 'none' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
            </Row>
            {isExp && renderDir(e.path, depth + 1)}
          </div>
        );
      }
      const isSel = selected.has(e.path);
      const isOpen = e.path === selectedPath;
      const { Icon: FIcon, color: fcolor } = fileVisual(e.name);
      return (
        <Row key={e.path}
          onClick={(ev) => onRowClick(ev, e)}
          onMiddle={() => void openFile(e, true)}
          onContext={(ev) => onRowContext(ev, e)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `6px 8px 6px ${pl}px`, borderRadius: 5, color: isSel || isOpen ? '#e9e9ec' : '#a8a8b0', background: isSel ? '#33333c' : isOpen ? '#26262b' : undefined, cursor: 'pointer' }}>
          <FIcon size={15} weight="fill" color={isSel || isOpen ? '#e9e9ec' : fcolor} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
        </Row>
      );
    });
  }

  // What the menu acts on: the whole selection if the right-clicked row is part of it,
  // otherwise just that row (onRowContext has already collapsed the selection to it).
  // Recomputed every render from current `selected`/`menu` state, so it can't go stale.
  const targets: string[] = menu
    ? (selected.has(menu.entry.path) ? [...selected] : [menu.entry.path])
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '9px 12px', borderBottom: '1px solid #1d1d21', font: '400 11px var(--font-mono)', color: '#6a6a72', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project ? homeAbbrev(project.workingDir) : ''}</span>
        <button title="Refresh" onClick={() => { setChildren({}); setExpanded(new Set()); void loadDir('.'); }} style={{ background: 'none', border: 'none', color: '#46464d', cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>⟳</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 6, font: `400 ${fs}px/1.4 var(--font-mono)` }}>
        {renderDir('.', 0)}
        {!(children['.']?.length) && <div style={{ padding: 8, color: 'var(--color-text-tertiary)' }}>Empty</div>}
      </div>
      {menu && (
        <>
          <div onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000, minWidth: 168, padding: 4, background: 'var(--color-elevated, #26262b)', border: '1px solid #37373d', borderRadius: 8, boxShadow: '0 10px 30px -10px rgba(0,0,0,.7)' }}>
            <button type="button" onClick={() => { const entry = menu.entry; setMenu(null); void saveAs(entry); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <DownloadSimple size={15} /> Save As…
            </button>
            <button type="button" onClick={() => { const entry = menu.entry; setMenu(null); void renameEntry(entry); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <PencilSimple size={15} /> Rename
            </button>
            <div style={{ height: 1, background: '#37373d', margin: '4px 6px' }} />
            <button type="button" onClick={() => { const entry = menu.entry; setMenu(null); void deleteEntry(entry); }}
              style={{ ...MENU_ITEM, color: '#f87171' }}>
              <TrashSimple size={15} /> {targets.length > 1 ? `Delete ${targets.length} items` : 'Delete'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
