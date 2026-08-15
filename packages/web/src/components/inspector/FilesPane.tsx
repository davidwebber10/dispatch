import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLineLeft, CaretRight, Copy, DownloadSimple, FolderOpen, GitBranch, ImageSquare, MagnifyingGlass, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { FileEntry } from '../../api/types';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useSettings } from '../../stores/settings';
import { useHost } from '../../stores/host';
import { useGitStatus, gitStatusFor } from '../../stores/gitStatus';
import { fileVisual } from '../common/typeIcons';
import { fuzzyFilter } from '../../lib/fuzzy';
import { saveFilesAs, type RemoteFile } from '../../lib/saveFiles';
import { clipboardImageSupported, copyImageToClipboard, copyText } from '../../lib/clipboard';
import { isImage } from '../../lib/fileType';

const INDENT = 14;
const HIDDEN_KEY = 'dispatch:files-hidden';

const MENU_ITEM: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px',
  background: 'none', border: 'none', font: '400 13px var(--font-sans)', cursor: 'pointer',
  borderRadius: 6, textAlign: 'left',
};

const TOOL_BTN: React.CSSProperties = {
  width: 26, height: 26, flexShrink: 0, border: '1px solid var(--color-border)', borderRadius: 6,
  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
};

const STATUS_COLOR: Record<string, string> = {
  M: 'var(--color-status-yellow)', A: 'var(--color-accent)', D: 'var(--color-status-red)',
  R: 'var(--color-status-yellow)', '?': 'var(--color-text-tertiary)',
};

/** Parent directory of a working-dir-relative path (or '.' for a top-level entry). */
function parentDir(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(0, slash) : '.';
}

function homeAbbrev(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p;
}

/** Hidden = any dot-segment anywhere in the path (matches what the tree's per-level filter hides). */
export function isHiddenPath(p: string): boolean {
  return p.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

/** Compact human size for the meta column: 820b, 1.2k, 31k, 4.5M. */
export function fmtSize(n?: number | null): string {
  if (n == null) return '';
  if (n < 1000) return `${n}b`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Directories first, then name — the single ordering both the tree and Shift-ranges use. */
export function sortEntries(a: FileEntry, b: FileEntry): number {
  return Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name);
}

/**
 * The visible FILE rows in render order. This is the coordinate space a Shift-click range spans:
 * it must walk the tree exactly as renderDir does (same sort, same hidden filter, only into
 * expanded directories), or "select everything between these two rows" would select rows the
 * user can't see.
 */
export function flattenFiles(
  children: Record<string, FileEntry[]>,
  expanded: Set<string>,
  path = '.',
  showHidden = true,
): string[] {
  const out: string[] = [];
  for (const e of (children[path] ?? []).slice().sort(sortEntries)) {
    if (!showHidden && e.name.startsWith('.')) continue;
    if (e.isDirectory) {
      if (expanded.has(e.path)) out.push(...flattenFiles(children, expanded, e.path, showHidden));
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

/** A path with its fuzzy-matched characters highlighted; the directory part stays dim. */
function HighlightedPath({ path, indices }: { path: string; indices: number[] }) {
  const hit = new Set(indices);
  const baseStart = path.lastIndexOf('/') + 1;
  return (
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
      {/* rtl + ltr embed: long paths truncate on the LEFT so the basename stays visible */}
      <span style={{ unicodeBidi: 'plaintext' }}>
        {path.split('').map((ch, i) => (
          <span key={i} style={{
            color: hit.has(i) ? 'var(--color-accent)' : i < baseStart ? 'var(--color-text-tertiary)' : undefined,
            fontWeight: hit.has(i) ? 700 : undefined,
          }}>{ch}</span>
        ))}
      </span>
    </span>
  );
}

export function FilesPane({ projectId, onOpenFile }: { projectId: string | null; onOpenFile: (terminalId: string) => void }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'tree' | 'changed'>('tree');
  const [showHidden, setShowHidden] = useState<boolean>(() => { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; } });
  const [flat, setFlat] = useState<{ files: string[]; truncated: boolean } | null>(null);
  // True when the index fetch failed or timed out — renders a retry heading instead of the
  // eternal "SEARCHING…" a hung request used to leave behind (a socket that dies mid-blip
  // never rejects). `flat` stays null in that state, so the next keystroke retries.
  const [flatError, setFlatError] = useState(false);
  const project = useProjects((s) => s.sessions.find((x) => x.id === projectId));
  const activeTabId = useTabs((s) => s.activeTabId);
  const tabsForProj = useTabs((s) => (projectId ? s.byProject[projectId] : undefined)) ?? [];
  const selectedPath = tabsForProj.find((t) => t.id === activeTabId && t.type === 'file')?.config?.path as string | undefined;
  const fs = useSettings((s) => s.sidebarFontSize);
  const canReveal = useHost((s) => s.canReveal);
  const fileManagerName = useHost((s) => s.fileManagerName);
  const git = useGitStatus((s) => gitStatusFor(s.byProject, projectId));

  const loadDir = useCallback(async (path: string) => {
    if (!projectId) return;
    try {
      const entries = await api.listFiles(projectId, path);
      setChildren((prev) => ({ ...prev, [path]: entries }));
    } catch { setChildren((prev) => ({ ...prev, [path]: [] })); }
  }, [projectId]);

  useEffect(() => {
    setChildren({}); setExpanded(new Set()); setSelected(new Set()); setAnchor(null);
    setQuery(''); setMode('tree'); setFlat(null);
    if (projectId) {
      void loadDir('.');
      void useGitStatus.getState().refresh(projectId);
    }
  }, [projectId, loadDir]);

  // The all-files search index is fetched lazily, on the first keystroke. A big cold
  // project can take a long while to walk, and a request fired into a network blip can hang
  // outright — either way the pane used to sit on a bare "SEARCHING…" with no hint. After
  // 15s the heading flips to the slow/unavailable notice, but the request is NOT abandoned:
  // a late success still lands and replaces it (the timeout only re-labels, never cancels).
  useEffect(() => {
    if (!query || flat || !projectId) return;
    let stale = false;
    setFlatError(false);
    const slowTimer = setTimeout(() => { if (!stale) setFlatError(true); }, 15_000);
    api.listFilesFlat(projectId)
      .then((r) => { if (!stale) { clearTimeout(slowTimer); setFlat(r); setFlatError(false); } })
      .catch(() => { if (!stale) { clearTimeout(slowTimer); setFlatError(true); } }); // flat stays null → the next keystroke retries
    return () => { stale = true; clearTimeout(slowTimer); };
  }, [query, flat, projectId]);

  function toggleHidden() {
    setShowHidden((prev) => {
      const v = !prev;
      try { localStorage.setItem(HIDDEN_KEY, v ? '1' : '0'); } catch { /* ignore */ }
      return v;
    });
  }

  function refresh() {
    setChildren({}); setExpanded(new Set()); setSelected(new Set()); setAnchor(null); setFlat(null);
    if (projectId) { void loadDir('.'); void useGitStatus.getState().refresh(projectId); }
  }

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

  // Untracked directories arrive from porcelain as one `dir/` record with no per-file rows;
  // files under them inherit the '?' through this prefix list.
  const changedDirPrefixes = useMemo(
    () => Object.keys(git.changed).filter((p) => p.endsWith('/')),
    [git.changed],
  );
  const statusFor = useCallback((path: string): string => {
    const exact = git.changed[path];
    if (exact) return exact;
    for (const d of changedDirPrefixes) if (path.startsWith(d)) return git.changed[d];
    return '';
  }, [git.changed, changedDirPrefixes]);

  function nameOf(p: string): string {
    return entryByPath.get(p)?.name ?? p.split('/').pop() ?? p;
  }

  async function saveTargets(paths: string[]) {
    if (!projectId) return;
    const files: RemoteFile[] = paths.map((p) => ({ url: api.downloadUrl(projectId, p), name: nameOf(p) }));
    try { await saveFilesAs(files); }
    catch (err: any) { window.alert(`Save failed: ${err?.message ?? err}`); }
  }

  // Only ever offered for a LONE image: ClipboardItem accepts one item, and only an image
  // MIME type actually pastes into an upload field. Multiple files is Reveal's job.
  async function copyImage(p: string) {
    if (!projectId) return;
    try { await copyImageToClipboard(api.imageUrl(projectId, p)); }
    catch { window.alert('Copy failed — the browser refused to put this image on the clipboard.'); }
  }

  // copyText, not navigator.clipboard directly: the Clipboard API only exists in a SECURE
  // context, and Dispatch's documented remote access (http://<host>.ts.net:3456) is not one.
  // Text can still reach the clipboard there via the legacy path, so this stays offered.
  async function copyPaths(paths: string[]) {
    const wd = (project?.workingDir ?? '').replace(/\/+$/, '');
    const abs = paths.map((p) => (wd ? `${wd}/${p}` : p));
    try { await copyText(abs.join('\n')); }
    catch { window.alert('Copy failed — the clipboard is unavailable.'); }
  }

  async function reveal(paths: string[]) {
    if (!projectId) return;
    try { await api.revealFiles(projectId, paths); }
    catch (err: any) { window.alert(`Reveal failed: ${err?.message ?? err}`); }
  }

  async function deleteTargets(paths: string[]) {
    if (!projectId) return;
    const label = paths.length === 1 ? `"${nameOf(paths[0])}"` : `${paths.length} items`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    const dirs = new Set(paths.map(parentDir));
    try {
      for (const p of paths) await api.deleteFile(projectId, p);
      setSelected(new Set());
      for (const d of dirs) await loadDir(d);
    } catch (err: any) { window.alert(`Delete failed: ${err?.message ?? err}`); }
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

  function toggle(path: string) {
    const collapsing = expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (collapsing) next.delete(path);
      else next.add(path);
      return next;
    });

    if (!collapsing) {
      if (!children[path]) void loadDir(path);
      return;
    }

    // Collapsing hides every descendant row, so drop them from the selection — Finder does the
    // same. Leaving them in would mean a later "Delete 2 items" silently deletes a file the user
    // can no longer SEE, which is destructive. The anchor goes too if it pointed at one of them,
    // so a following Shift-click can't range from an invisible row.
    const prefix = `${path}/`;
    setSelected((prev) => new Set([...prev].filter((p) => !p.startsWith(prefix))));
    setAnchor((prev) => (prev?.startsWith(prefix) ? null : prev));
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
      // Anchor moves to the toggled row even when the toggle DESELECTED it, so a following
      // Shift-click ranges from here — matches Finder and is intentional.
      setAnchor(entry.path);
      return;
    }
    if (ev.shiftKey && anchor) {
      const flatRows = flattenFiles(children, expanded, '.', showHidden);
      const i = flatRows.indexOf(anchor);
      const j = flatRows.indexOf(entry.path);
      // If the anchor's row isn't currently visible (e.g. its directory got collapsed),
      // indexOf returns -1 and this guard deliberately falls through to plain-click
      // semantics below, rather than ranging over rows the user can't see.
      if (i >= 0 && j >= 0) {
        const [lo, hi] = i <= j ? [i, j] : [j, i];
        setSelected(new Set(flatRows.slice(lo, hi + 1)));
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
    const entries = (children[path] ?? []).slice().sort(sortEntries)
      .filter((e) => showHidden || !e.name.startsWith('.'));
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
      const st = statusFor(e.path);
      return (
        <Row key={e.path}
          onClick={(ev) => onRowClick(ev, e)}
          onMiddle={() => void openFile(e, true)}
          onContext={(ev) => onRowContext(ev, e)}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: `6px 8px 6px ${pl}px`, borderRadius: 5, color: isSel || isOpen ? '#e9e9ec' : '#a8a8b0', background: isSel ? '#33333c' : isOpen ? '#26262b' : undefined, cursor: 'pointer' }}>
          <FIcon size={15} weight="fill" color={isSel || isOpen ? '#e9e9ec' : fcolor} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
          <span style={{ flexShrink: 0, font: '400 9.5px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{fmtSize(e.size)}</span>
          {st && <span style={{ flexShrink: 0, width: 12, textAlign: 'center', font: '700 10px var(--font-mono)', color: STATUS_COLOR[st] ?? 'var(--color-text-tertiary)' }}>{st}</span>}
        </Row>
      );
    });
  }

  /** A row in the search / changed flat lists: full path, optional highlight, status letter. */
  function renderFlatRow(path: string, indices: number[] | null, st: string) {
    const entry: FileEntry = { name: baseName(path), isDirectory: false, path: path.replace(/\/+$/, '') };
    const isOpen = entry.path === selectedPath;
    const { Icon: FIcon, color: fcolor } = fileVisual(entry.name);
    return (
      <Row key={path}
        onClick={() => { setSelected(new Set([entry.path])); setAnchor(entry.path); void openFile(entry); }}
        onMiddle={() => void openFile(entry, true)}
        onContext={(ev) => onRowContext(ev, entry)}
        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 8px', borderRadius: 5, color: isOpen ? '#e9e9ec' : '#a8a8b0', background: isOpen ? '#26262b' : undefined, cursor: 'pointer' }}>
        <FIcon size={15} weight="fill" color={isOpen ? '#e9e9ec' : fcolor} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex' }}>
          {indices
            ? <HighlightedPath path={path} indices={indices} />
            : <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>}
        </span>
        {st && <span style={{ flexShrink: 0, width: 12, textAlign: 'center', font: '700 10px var(--font-mono)', color: STATUS_COLOR[st] ?? 'var(--color-text-tertiary)' }}>{st}</span>}
      </Row>
    );
  }

  const searching = query.trim().length > 0;
  const searchRows = useMemo(() => {
    if (!searching || !flat) return [];
    const pool = showHidden ? flat.files : flat.files.filter((p) => !isHiddenPath(p));
    return fuzzyFilter(query.trim(), pool);
  }, [searching, flat, query, showHidden]);

  const changedRows = useMemo(
    () => Object.entries(git.changed).sort(([a], [b]) => a.localeCompare(b)),
    [git.changed],
  );

  const heading = searching
    ? (flat
        ? `${searchRows.length} MATCHES${flat.truncated ? ' · INDEX TRUNCATED' : ''}`
        : flatError ? 'INDEX SLOW OR UNAVAILABLE · STILL TRYING' : 'SEARCHING…')
    : mode === 'changed' ? `UNCOMMITTED${git.branch ? ` · ${git.branch.toUpperCase()}` : ''}`
    : 'PROJECT TREE';

  const segStyle = (on: boolean): React.CSSProperties => ({
    flex: 1, textAlign: 'center', font: `400 11px var(--font-sans)`, padding: '4px 0', borderRadius: 6,
    cursor: 'pointer', border: 'none',
    background: on && !searching ? 'var(--color-hover)' : 'var(--color-elevated)',
    color: on && !searching ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  });

  // What the menu acts on: the whole selection if the right-clicked row is part of it,
  // otherwise just that row (onRowContext has already collapsed the selection to it).
  // Recomputed every render from current `selected`/`menu` state, so it can't go stale.
  const targets: string[] = menu
    ? (selected.has(menu.entry.path) ? [...selected] : [menu.entry.path])
    : [];

  // The lone image case is the ONLY one the browser clipboard can serve as a real file — and even
  // then only in a SECURE context: over plain http (the README's http://<mac>.ts.net:3456)
  // navigator.clipboard and ClipboardItem simply do not exist, so offering "Copy Image" there
  // would just hand the user an alert saying it failed. Don't offer what cannot work.
  const loneImage = targets.length === 1 && isImage(targets[0]) && clipboardImageSupported()
    ? targets[0]
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* root + branch */}
      <div style={{ padding: '9px 10px', borderBottom: '1px solid #1d1d21', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ flex: 1, minWidth: 0, font: '400 11px var(--font-mono)', color: '#6a6a72', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {project ? homeAbbrev(project.workingDir) : ''}
        </span>
        {git.branch && (
          <span title="Current branch" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
            font: '500 10.5px var(--font-mono)', color: 'var(--color-accent)',
            background: 'rgba(62,207,106,0.08)', border: '1px solid rgba(62,207,106,0.25)',
            borderRadius: 5, padding: '1px 6px', maxWidth: 140,
          }}>
            <GitBranch size={11} weight="bold" style={{ flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{git.branch}</span>
          </span>
        )}
        <button title="Refresh" onClick={refresh} style={{ background: 'none', border: 'none', color: '#46464d', cursor: 'pointer', fontSize: 14, flexShrink: 0, padding: 0 }}>⟳</button>
      </div>

      {/* search + view toggles */}
      <div style={{ padding: '8px 10px 6px', display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '5px 8px' }}>
          <MagnifyingGlass size={12} color="var(--color-text-tertiary)" style={{ flexShrink: 0 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter files… (fuzzy)"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' }} />
          {query && (
            <button onClick={() => setQuery('')} title="Clear"
              style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', fontSize: 11, padding: 0, flexShrink: 0 }}>×</button>
          )}
        </div>
        <button onClick={toggleHidden} title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          style={{ ...TOOL_BTN, font: '600 11px var(--font-mono)', background: showHidden ? 'var(--color-accent)' : 'transparent', color: showHidden ? '#08240F' : 'var(--color-text-secondary)' }}>·*</button>
        <button onClick={() => setExpanded(new Set())} title="Collapse all"
          style={{ ...TOOL_BTN, background: 'transparent', color: 'var(--color-text-secondary)' }}>
          <ArrowLineLeft size={13} />
        </button>
      </div>

      {/* mode filters */}
      <div style={{ display: 'flex', gap: 4, padding: '2px 10px 8px', flexShrink: 0 }}>
        <button onClick={() => { setMode('tree'); setQuery(''); }} style={segStyle(mode === 'tree')}>Tree</button>
        <button onClick={() => { setMode('changed'); setQuery(''); }} style={segStyle(mode === 'changed')}>
          Changed{git.count > 0 && <span style={{ color: 'var(--color-status-yellow)', marginLeft: 4 }}>{git.count}</span>}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 6px 8px', font: `400 ${fs}px/1.4 var(--font-mono)` }}>
        <div style={{ padding: '2px 4px 5px', font: '500 9.5px var(--font-mono)', letterSpacing: '0.1em', color: 'var(--color-text-tertiary)' }}>{heading}</div>
        {searching
          ? searchRows.map((r) => renderFlatRow(r.path, r.indices, statusFor(r.path)))
          : mode === 'changed'
          ? (changedRows.length
              ? changedRows.map(([p, st]) => renderFlatRow(p, null, st))
              : <div style={{ padding: 8, color: 'var(--color-text-tertiary)' }}>No uncommitted changes</div>)
          : (
            <>
              {renderDir('.', 0)}
              {!(children['.']?.length) && <div style={{ padding: 8, color: 'var(--color-text-tertiary)' }}>Empty</div>}
            </>
          )}
      </div>
      {menu && (
        <>
          <div onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}
            style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
          <div role="menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000, minWidth: 190, padding: 4, background: 'var(--color-elevated, #26262b)', border: '1px solid #37373d', borderRadius: 8, boxShadow: '0 10px 30px -10px rgba(0,0,0,.7)' }}>
            <button type="button" onClick={() => { const t = targets; setMenu(null); void saveTargets(t); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <DownloadSimple size={15} /> {targets.length > 1 ? `Save ${targets.length} Files As…` : 'Save As…'}
            </button>
            {loneImage && (
              <button type="button" onClick={() => { const p = loneImage; setMenu(null); void copyImage(p); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <ImageSquare size={15} /> Copy Image
              </button>
            )}
            <button type="button" onClick={() => { const t = targets; setMenu(null); void copyPaths(t); }}
              style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
              <Copy size={15} /> {targets.length > 1 ? `Copy ${targets.length} Paths` : 'Copy Path'}
            </button>
            {canReveal && (
              <button type="button" onClick={() => { const t = targets; setMenu(null); void reveal(t); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <FolderOpen size={15} /> Reveal in {fileManagerName ?? 'Finder'}
              </button>
            )}
            {targets.length === 1 && (
              <button type="button" onClick={() => { const entry = menu.entry; setMenu(null); void renameEntry(entry); }}
                style={{ ...MENU_ITEM, color: '#e9e9ec' }}>
                <PencilSimple size={15} /> Rename
              </button>
            )}
            <div style={{ height: 1, background: '#37373d', margin: '4px 6px' }} />
            <button type="button" onClick={() => { const t = targets; setMenu(null); void deleteTargets(t); }}
              style={{ ...MENU_ITEM, color: '#f87171' }}>
              <TrashSimple size={15} /> {targets.length > 1 ? `Delete ${targets.length} items` : 'Delete'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
