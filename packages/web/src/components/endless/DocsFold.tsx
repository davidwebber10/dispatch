import { useRef, useState } from 'react';
import { CaretDown, CaretRight, FileText } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { EndlessDocRow } from '../../api/types';
import { useDocViewer } from '../../stores/docViewer';
import { useUI } from '../../stores/ui';
import { useIsMobile } from '../../hooks/useIsMobile';
import { openThreadInPlace } from './openThread';
import { MoreButton, formatStart } from './paneParts';

/** The short location of a Docs row; the full form (with the branch) is its title. */
const shortLocation = (r: EndlessDocRow) => (r.source === 'worktree' ? `worktree ${r.worktree}` : `branch ${r.branch}`);
const fullLocation = (r: EndlessDocRow) =>
  r.source === 'worktree' ? `worktree ${r.worktree}${r.branch ? ` on ${r.branch}` : ''}` : `branch ${r.branch}, as of the last fetch`;
const VS: Record<EndlessDocRow['vsMain'], string> = { changed: 'changed here', not_on_main: 'not on main' };

const mono = (size: number, color = 'var(--color-text-tertiary)'): React.CSSProperties => ({ fontFamily: 'var(--font-mono)', fontSize: size, color });

function Chip({ children, title, mobile }: { children: React.ReactNode; title?: string; mobile: boolean }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', minHeight: mobile ? 22 : 20, padding: '1px 6px', boxSizing: 'border-box', borderRadius: 5, maxWidth: '100%',
      background: 'var(--color-pane)', border: '1px solid var(--color-border)', ...mono(11, 'var(--color-text-secondary)'), lineHeight: 1.4,
      whiteSpace: 'normal', overflowWrap: 'anywhere',
    }}>{children}</span>
  );
}

/**
 * A project's in-progress docs in the Chat pane (spec 12.7, board PaneStates S8): "Docs (N)", closed
 * by default and hidden at 0. The first open loads the rows (at most 5, newest first); a later open
 * reuses them, unless the count changed since that load. A row opens the doc viewer; the writer
 * opens its thread; "+N more" opens the project in Threads.
 */
export function DocsFold({ projectId, count, onNavigate, first = true }: { projectId: string; count: number; onNavigate?: () => void; first?: boolean }) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ rows: EndlessDocRow[]; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  /** The count when the rows last loaded: an open after the count changed loads them again. */
  const loadedAt = useRef<number | null>(null);
  if (count === 0) return null;

  const load = async () => {
    if (loading.current) return;
    loading.current = true;
    loadedAt.current = count;
    setFailed(false);
    try { setList(await api.endlessDocs(projectId)); } catch { setFailed(true); } finally { loading.current = false; }
  };
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && (!list || loadedAt.current !== count)) void load();
  };
  const openDoc = (r: EndlessDocRow) => {
    onNavigate?.();
    // A worktree copy is read by its worktree name, a branch copy from its branch.
    useDocViewer.getState().show(r.source === 'branch'
      ? { project: projectId, path: r.path, branch: r.branch }
      : { project: projectId, path: r.path, branch: null, worktree: r.worktree });
  };

  const more = list ? list.total - list.rows.length : 0;
  return (
    <>
      <MoreButton mobile={mobile} first={first} expanded={open} onClick={toggle}>
        <FileText size={12} aria-hidden />Docs ({count})<span style={{ flex: 1 }} />
        {open ? <CaretDown size={12} aria-hidden /> : <CaretRight size={12} aria-hidden />}
      </MoreButton>
      {open && !list && (
        <p role={failed ? 'alert' : undefined} aria-busy={!failed} style={{ margin: 0, padding: '8px 0 4px', fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          {failed ? 'Docs could not be loaded.' : 'Loading docs…'}
        </p>
      )}
      {open && list && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column' }}>
          {list.rows.map((r) => (
            // The row is a tap target as a whole; its button gives the keyboard the same action, and the writer is its own button.
            <div key={`${r.source}:${r.branch ?? r.worktree}:${r.path}`} data-testid={`doc-row-${r.path}`} onClick={() => openDoc(r)}
              style={{ padding: mobile ? '10px 0' : '8px 0', borderTop: '1px solid var(--color-border)', cursor: 'pointer' }}>
              <button type="button" title={r.path} onClick={(e) => { e.stopPropagation(); openDoc(r); }}
                style={{ display: 'block', width: '100%', minHeight: mobile ? 44 : undefined, textAlign: 'left', background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-text-primary)', font: 'inherit' }}>
                <span style={{ display: 'block', ...mono(mobile ? 12.5 : 12, 'var(--color-text-primary)'), lineHeight: 1.45, overflowWrap: 'anywhere' }}>{r.name}</span>
                {r.status && <span style={{ display: 'block', fontSize: mobile ? 12.5 : 12, lineHeight: 1.5, color: 'var(--color-text-secondary)', marginTop: 2 }}>{r.status}</span>}
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  <Chip mobile={mobile} title={fullLocation(r)}>{shortLocation(r)}</Chip>
                  <Chip mobile={mobile}>{VS[r.vsMain]}</Chip>
                </span>
              </button>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 4, marginTop: 4, ...mono(mobile ? 11.5 : 11), lineHeight: 1.6 }}>
                <span>{formatStart(r.modifiedAt)}</span>
                {r.writer && (
                  <>
                    <span aria-hidden>·</span>
                    <button type="button" title="Open the thread that wrote it"
                      onClick={(e) => { e.stopPropagation(); onNavigate?.(); void openThreadInPlace(projectId, r.writer!.id); }}
                      style={{ ...(mobile ? { minHeight: 44, display: 'inline-flex', alignItems: 'center' } : {}), background: 'transparent', border: 0, padding: mobile ? '4px 0' : 0, cursor: 'pointer', ...mono(mobile ? 11.5 : 11, 'var(--color-text-secondary)'), lineHeight: 1.6, textAlign: 'left', overflowWrap: 'anywhere', textDecoration: 'underline', textDecorationColor: 'var(--color-border)', textUnderlineOffset: 2 }}>
                      {r.writer.label}
                    </button>
                  </>
                )}
                {r.copies > 1 && <><span aria-hidden>·</span><span>+{r.copies - 1} {r.copies - 1 === 1 ? 'copy' : 'copies'}</span></>}
              </div>
            </div>
          ))}
          {more > 0 && (
            <MoreButton mobile={mobile} first onClick={() => { onNavigate?.(); useUI.getState().requestOpenProject(projectId); }}>
              +{more} more
            </MoreButton>
          )}
        </div>
      )}
    </>
  );
}
