import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Code, Copy, FileText, FolderOpen, GitBranch, Lock, MagnifyingGlass, X } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { EndlessDocCopy } from '../../api/types';
import { Modal } from '../common/Modal';
import { Markdown } from '../Markdown';
import { useDocViewer, type DocRef } from '../../stores/docViewer';
import { useEndless } from '../../stores/endless';
import { useHost } from '../../stores/host';
import { useSettings } from '../../stores/settings';
import { useIsMobile } from '../../hooks/useIsMobile';
import { docName, projectForPath } from '../../lib/docPaths';
import { classifyLink } from '../../lib/docLinks';
import { useProjects } from '../../stores/projects';
import { formatStart } from './paneParts';

/** The editors "Open in editor" can use: the browser opens the editor's URL, the daemon runs nothing. */
const EDITOR_SCHEME: Record<string, string> = { vscode: 'vscode', cursor: 'cursor', zed: 'zed' };
/** The editor URL of an absolute path; each segment is encoded, so `#`, `?` and `%` stay in the path. */
export const editorUrl = (editor: string, abs: string) => `${EDITOR_SCHEME[editor]}://file${abs.split('/').map(encodeURIComponent).join('/')}`;
/** Open a URL with a link click, not `location.href`: that would fire the app's beforeunload guard. */
function openUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
/** The HTTP status in the API client's error text ("GET /api/... failed: 404 — ..."), or 0. */
const statusOf = (e: unknown) => Number(/ failed: (\d{3})\b/.exec(e instanceof Error ? e.message : '')?.[1] ?? 0);
/** Where the copy came from (spec 12.4). */
export const LOCATION = (d: { source: string; worktree: string | null; branch: string | null; remote?: boolean }) =>
  d.source === 'main' ? 'main' : d.source === 'worktree' ? `worktree ${d.worktree}${d.branch ? ` on ${d.branch}` : ''}` : `branch ${d.branch}${d.remote ? ', as of the last fetch' : ''}`;
const VS: Record<EndlessDocCopy['vsMain'], string | null> = { same: 'on main', changed: 'changed here', not_on_main: 'not on main', unknown: null };

type Load = { kind: 'loading' } | { kind: 'doc'; doc: EndlessDocCopy } | { kind: 'error'; status: number };

const ERROR_TEXT: Record<number, string> = {
  404: 'This file is not in the project, its worktrees or its branches.',
  403: 'This path is outside the project.',
  413: 'This file is larger than 2 MB, so it does not open here.',
};

const mono = (size: number, color = 'var(--color-text-tertiary)'): React.CSSProperties => ({ fontFamily: 'var(--font-mono)', fontSize: size, color });

/** The path of `abs` inside `folder`, or null when it is not inside it. */
function relativeTo(abs: string, folder: string | undefined): string | null {
  if (!folder) return null;
  const root = folder.replace(/\/+$/, '');
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
}

/** The text "Copy path" copies: the absolute path, or `branch:path` for a branch-only copy. */
const pathText = (ref: DocRef, doc: EndlessDocCopy | null) =>
  doc ? (doc.absPath ?? `${doc.branch}:${doc.path}`) : ref.branch ? `${ref.branch}:${ref.path}` : ref.path;

/**
 * The doc viewer (spec 12.4; boards DocViewer, DocStates, PhoneDoc): one doc in place over Chat, read only.
 * Mounted once in ChatMode; `useDocViewer` says which doc. A link inside the doc opens the next doc, and Back returns.
 */
export function DocViewer({ owner }: { owner?: string } = {}) {
  const shown = useDocViewer((s) => s.open);
  // One viewer per surface: Chat's has no owner; a thread's shows only a doc its own message opened.
  const open = shown && (shown.origin ?? undefined) === owner ? shown : null;
  const back = useDocViewer((s) => s.back);
  const endlessProjects = useEndless((s) => s.projects);
  const sessions = useProjects((s) => s.sessions);
  // Chat loads its project list; a thread does not, so a project Chat has not loaded comes from the sessions.
  const projects = useMemo(() => {
    const known = new Set(endlessProjects.map((p) => p.id));
    return [...endlessProjects, ...sessions.filter((x) => !known.has(x.id)).map((x) => ({ id: x.id, folder: x.workingDir }))];
  }, [endlessProjects, sessions]);
  const canReveal = useHost((s) => s.canReveal);
  const fileManager = useHost((s) => s.fileManagerName) ?? 'Finder';
  const editor = useSettings((s) => s.editor);
  const mobile = useIsMobile();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    setNote(null);
    api.endlessDoc(open.project, open.path, open.branch, open.worktree ?? null)
      .then((doc) => { if (!cancelled) setState({ kind: 'doc', doc }); })
      .catch((e) => { if (!cancelled) setState({ kind: 'error', status: statusOf(e) }); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return; // another layer (a menu, a lightbox) took the key
      e.preventDefault();
      useDocViewer.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const project = open?.project ?? null;
  const loaded = state.kind === 'doc' ? state.doc : null;
  const copySource = loaded?.source, copyWorktree = loaded?.worktreeRel ?? loaded?.worktree, copyBranch = loaded?.branch;
  // Stable per project list and open copy: the Markdown chips are redrawn when this changes.
  const docs = useMemo(() => ({
    onOpen: (p: string, b: string | null) => {
      if (!project) return;
      const target = projectForPath(p, project, projects) ?? project;
      const extra: { worktree?: string; branch?: string } = {};
      // A relative link with no branch keeps the copy that is open (not an absolute path, not a worktree path).
      if (!b && !p.startsWith('/') && !/^(\.worktrees|\.claude\/worktrees)\//.test(p) && target === project) {
        if (copySource === 'worktree' && copyWorktree) extra.worktree = copyWorktree;
        else if (copySource === 'branch' && copyBranch) extra.branch = copyBranch;
      }
      useDocViewer.getState().push({ project: target, path: p, branch: b ?? extra.branch ?? null, origin: open?.origin ?? null, ...(extra.worktree ? { worktree: extra.worktree } : {}) });
    },
  }), [project, open?.origin, projects, copySource, copyWorktree, copyBranch]);

  if (!open) return null;
  const close = () => useDocViewer.getState().close();
  /**
   * A link in the doc never navigates the app (see lib/docLinks): a doc link opens in the viewer (a
   * relative one keeps the copy that is open); only an http(s) or mailto link opens a new tab; every
   * other link does nothing.
   */
  const onLink = (e: React.MouseEvent<HTMLElement>) => {
    const a = (e.target as HTMLElement).closest?.('a[href]');
    if (!a || !e.currentTarget.contains(a)) return;
    e.preventDefault();
    const href = a.getAttribute('href') ?? '';
    const act = classifyLink(href, { project: open.project, projects, from: state.kind === 'doc' ? state.doc.path : open.path });
    if (act.kind === 'doc') docs.onOpen(act.path, null);
    else if (act.kind === 'web') window.open(href, '_blank', 'noopener,noreferrer');
  };
  const doc = state.kind === 'doc' ? state.doc : null;
  const name = docName(doc?.path ?? open.path);
  const folder = projects.find((p) => p.id === open.project)?.folder;
  const rel = doc?.absPath ? relativeTo(doc.absPath, folder) : null;
  const showReveal = canReveal && !!doc?.absPath && rel !== null;
  const showEditor = canReveal && !!doc?.absPath?.startsWith('/') && !!editor && !!EDITOR_SCHEME[editor];
  const vs = doc ? VS[doc.vsMain] : null;
  const prev = back[back.length - 1];

  const reveal = async () => {
    if (!rel) return;
    try { await api.revealFiles(open.project, [rel]); setNote(null); } catch { setNote(`The file could not be shown in ${fileManager}.`); }
  };
  const copyPath = async () => {
    try { await navigator.clipboard.writeText(pathText(open, doc)); setNote('Copied.'); } catch { setNote('The path could not be copied.'); }
  };

  const iconButton: React.CSSProperties = {
    width: mobile ? 44 : 32, height: mobile ? 44 : 32, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, border: 0, background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0,
  };
  const action: React.CSSProperties = {
    height: mobile ? 44 : 32, display: 'inline-flex', alignItems: 'center', gap: 6, padding: mobile ? '0 12px' : '0 10px', borderRadius: 8,
    border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap',
  };
  const chip: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, minHeight: 22, padding: '1px 7px', boxSizing: 'border-box', borderRadius: 5, maxWidth: '100%',
    background: 'var(--color-elevated)', border: '1px solid var(--color-border)', ...mono(mobile ? 11 : 11.5, 'var(--color-text-secondary)'), lineHeight: 1.4,
    whiteSpace: 'normal', overflowWrap: 'anywhere',
  };
  const copyButton = <button type="button" onClick={() => void copyPath()} style={action}><Copy size={15} aria-hidden />Copy path</button>;

  const message = (icon: React.ReactNode, text: string, alert: boolean, actions?: React.ReactNode) => (
    <div role={alert ? 'alert' : undefined} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '32px 16px', textAlign: 'center', fontSize: 13.5, color: 'var(--color-text-secondary)' }}>
      {icon}{text}{actions && <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>{actions}</div>}
    </div>
  );

  return (
    <Modal open onClose={close} sheet={mobile} maxWidth={880}>
      <div role="dialog" aria-modal="true" aria-label={name}
        style={{
          display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
          maxHeight: mobile ? 'calc(100dvh - 100px - env(safe-area-inset-top) - env(safe-area-inset-bottom))' : 'calc(100dvh - 80px)',
        }}>
        <div style={{ display: 'flex', alignItems: mobile ? 'flex-start' : 'center', gap: 8 }}>
          {prev ? (
            <button type="button" aria-label="Back" title={`Back to ${docName(prev.path)}`} onClick={() => useDocViewer.getState().pop()}
              style={{ ...iconButton, color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', background: 'var(--color-elevated)' }}>
              <ArrowLeft size={15} />
            </button>
          ) : !mobile && <FileText size={15} aria-hidden style={{ color: 'var(--color-text-secondary)', flex: 'none' }} />}
          <h2 title={doc?.path ?? open.path}
            style={{ margin: mobile ? '12px 0 0' : 0, flex: 1, minWidth: 0, font: `600 ${mobile ? 13.5 : 14}px/1.45 var(--font-mono)`, color: 'var(--color-text-primary)', ...(mobile ? { overflowWrap: 'anywhere' } : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }) }}>
            {name}
          </h2>
          <button type="button" aria-label="Close" onClick={close} style={iconButton}><X size={15} /></button>
        </div>

        {state.kind === 'loading' && (
          <div aria-busy="true" aria-label="Loading" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ width: 220, height: 22, borderRadius: 5, background: 'var(--color-hover)' }} />
              <div style={{ width: 90, height: 22, borderRadius: 5, background: 'var(--color-hover)' }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '20px 24px', borderRadius: 8, background: 'var(--color-base)' }}>
              {['55%', '35%', '90%', '80%'].map((w, k) => <div key={k} style={{ width: w, height: k === 0 ? 18 : 10, borderRadius: 5, background: 'var(--color-hover)', marginTop: k === 2 ? 10 : 0 }} />)}
            </div>
          </div>
        )}

        {doc && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <span style={chip}><GitBranch size={12} aria-hidden style={{ flex: 'none' }} />{LOCATION(doc)}</span>
              {vs && <span style={chip}>{vs}</span>}
              <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, marginLeft: mobile ? 0 : 6, ...mono(11.5) }}>
                {doc.status && <><span>{doc.status}</span><span aria-hidden>·</span></>}
                <span>modified {formatStart(doc.modifiedAt)}</span>
              </span>
            </div>
            {doc.note && <p style={{ margin: 0, ...mono(11.5, 'var(--color-text-secondary)') }}>{doc.note}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              {showReveal && <button type="button" onClick={() => void reveal()} style={action}><FolderOpen size={15} aria-hidden />Reveal in {fileManager}</button>}
              {showEditor && (
                <button type="button" onClick={() => openUrl(editorUrl(editor, doc.absPath!))} style={action}>
                  <Code size={15} aria-hidden />Open in editor
                </button>
              )}
              {copyButton}
              {note && <span role="status" style={mono(11.5, 'var(--color-text-secondary)')}>{note}</span>}
            </div>
            <div key={`${open.project}:${open.branch ?? ''}:${open.worktree ?? ''}:${open.path}`}
              style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-base)' }}>
              <article onClick={onLink} style={{ maxWidth: 680, margin: '0 auto', padding: mobile ? '24px 20px 34px' : '32px 24px', fontSize: 14.5, lineHeight: 1.75 }}>
                <Markdown source={doc.markdown} docs={docs} />
              </article>
            </div>
          </>
        )}

        {state.kind === 'error' && (
          state.status === 403
            ? message(<Lock size={18} aria-hidden style={{ color: 'var(--color-status-red)' }} />, ERROR_TEXT[403], true)
            : state.status === 404
              ? message(<MagnifyingGlass size={18} aria-hidden />, ERROR_TEXT[404], false, copyButton)
              : state.status === 413
                ? message(null, ERROR_TEXT[413], false, copyButton)
                : message(null, 'This doc could not be loaded.', true)
        )}
        {state.kind === 'error' && note && <span role="status" style={{ textAlign: 'center', ...mono(11.5, 'var(--color-text-secondary)') }}>{note}</span>}
      </div>
    </Modal>
  );
}
