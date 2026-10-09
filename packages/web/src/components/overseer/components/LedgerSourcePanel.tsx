// Overseer — the section panel (titles and source panel spec 2026-10-09, Unit 10).
//
// A click on a plan, doc or agent-with-file Source line of the pinned card shows the plan section
// the item comes from, without the need to open and search a large file. The daemon finds the file
// and the section (GET …/ledger/:itemId/source); the panel draws it with the app's markdown renderer,
// marks the item's row and scrolls to it.
//
//   • Desktop: over the chat column of the Control Plane (OverseerView), with ✕.
//   • Phone: a full-screen sheet over the Work tab (OverseerMobile), with a back button.
//   • The file name, the heading, the daemon's note when it read another copy (a worktree, or the
//     main checkout), the section, and "Open the full file" (the file tab, brought to the front).
//   • A dialog: focus moves in and back to the opener; what it covers is inert.
//   • No section matched: the outline; a click on a heading loads that section.
//   • Escape, ✕ or Back close it; a click on another Source line replaces it; a change of project
//     closes it. The panel shows the file as it is now.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Markdown } from '../../Markdown';
import { Icon } from '../atoms';
import { api } from '../../../api/client';
import { useProjects } from '../../../stores/projects';
import { useLedgerCard } from '../../../stores/ledgerCard';
import { openFileTab } from '../../../lib/openFileTab';
import type { LedgerSource } from '../../../api/types';

const close = () => useLedgerCard.getState().setSourcePanel(null);

/**
 * The element to give focus back to when the panel closes (review round 2): the last Source line
 * that opened or replaced it. A replacement keeps the panel open, so it never restores focus.
 */
let opener: HTMLElement | null = null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The element to mark for the item's source ID: the first table row whose first cell starts with
 * the ID as a whole word, else the first block that contains it as a whole word.
 */
export function sourceMarkTarget(root: HTMLElement, id: string): HTMLElement | null {
  const word = `${escapeRe(id.trim())}(?![\\p{L}\\p{N}])`;
  const starts = new RegExp(`^${word}`, 'iu');
  for (const row of root.querySelectorAll<HTMLElement>('tr')) {
    const first = row.querySelector('td, th');
    if (first && starts.test((first.textContent ?? '').trim())) return row;
  }
  const inside = new RegExp(`(?<![\\p{L}\\p{N}-])${word}`, 'iu');
  for (const block of root.querySelectorAll<HTMLElement>('p, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, dt, dd')) {
    if (inside.test(block.textContent ?? '')) return block;
  }
  return null;
}

/** The route's own error text from a failed request ("GET … failed: 404 — The file is gone"). */
const errorDetail = (e: unknown) => (e instanceof Error ? e.message.split(' — ').slice(1).join(' — ') : '');

const textButton: CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 12, color: 'var(--acc)', cursor: 'pointer',
};
const note: CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--ts)' };

export function LedgerSourcePanel({ mobile = false }: { mobile?: boolean } = {}) {
  const activeId = useProjects((s) => s.activeId);
  const panel = useLedgerCard((s) => s.sourcePanel);
  // A change of project closes it; it shows only over its own project.
  useEffect(() => {
    const open = useLedgerCard.getState().sourcePanel;
    if (open && open.projectId !== activeId) close();
  }, [activeId]);
  if (!panel || panel.projectId !== activeId) return null;
  // Keyed by the item: a click on another Source line starts again (no outline choice, no old text).
  return <PanelBody key={`${panel.projectId}:${panel.seq}`} projectId={panel.projectId} seq={panel.seq} mobile={mobile} />;
}

type Load = { status: 'loading' } | { status: 'error'; detail: string } | { status: 'ready'; data: LedgerSource };

function PanelBody({ projectId, seq, mobile }: { projectId: string; seq: number; mobile: boolean }) {
  const [heading, setHeading] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    setLoad({ status: 'loading' });
    api.getLedgerSource(projectId, seq, heading).then(
      (data) => { if (live) setLoad({ status: 'ready', data }); },
      (e: unknown) => { if (live) setLoad({ status: 'error', detail: errorDetail(e) }); },
    );
    return () => { live = false; };
  }, [projectId, seq, heading, attempt]);

  useEffect(() => {
    // Review rounds 1 and 2: an open chip popover takes the Escape (it closes alone and calls
    // preventDefault, whichever listener runs first).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || useLedgerCard.getState().popover) return; // the popover goes first
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Review round 1: focus moves into the panel and back to the opener on close; what the panel
  // covers (its siblings: the chat on desktop, the whole Work screen on the phone) is inert, so
  // Tab never reaches a hidden control. The card in the right pane stays usable on desktop.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = sectionRef.current;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !el?.contains(active)) opener = active;
    el?.focus({ preventScroll: true });
    const covered = el?.parentElement
      ? [...el.parentElement.children].filter((c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.hasAttribute('inert'))
      : [];
    for (const c of covered) c.setAttribute('inert', '');
    return () => {
      for (const c of covered) c.removeAttribute('inert');
      // Only a real close gives focus back; a replacement (another Source line) keeps the panel open.
      if (useLedgerCard.getState().sourcePanel) return;
      const back = opener;
      opener = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, []);

  // After the section renders: mark the item's row and bring it into view.
  const bodyRef = useRef<HTMLDivElement>(null);
  const data = load.status === 'ready' ? load.data : null;
  useEffect(() => {
    if (data?.kind !== 'section' || !data.id || !bodyRef.current) return;
    const target = sourceMarkTarget(bodyRef.current, data.id);
    if (!target) return;
    target.setAttribute('data-source-mark', 'true');
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [data]);

  const openFull = () => { if (data) void openFileTab(projectId, data.path, { focus: true }); };

  return (
    <section
      ref={sectionRef}
      role="dialog"
      aria-modal={mobile ? 'true' : undefined}
      tabIndex={-1}
      data-testid="ledger-source-panel"
      data-sheet={mobile ? 'true' : undefined}
      aria-label="Source section"
      // Above the chat's floating buttons (the jump and "Loading earlier" pills use 5) and the drill overlay.
      style={{ position: 'absolute', inset: 0, zIndex: 10, display: 'flex', flexDirection: 'column', background: 'var(--base)', outline: 'none' }}
    >
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--border)', background: 'var(--pane)' }}>
        {mobile && (
          <button type="button" aria-label="Back" onClick={close} style={{ ...textButton, display: 'flex', alignItems: 'center' }}>
            <Icon name="ph-arrow-left" size={20} color="var(--acc)" />
          </button>
        )}
        <span title={data?.path} style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--tp)' }}>
          {data?.file ?? ''}
        </span>
        <span style={{ flex: 1 }} />
        {data && <button type="button" onClick={openFull} style={textButton}>Open the full file</button>}
        {!mobile && (
          <button type="button" aria-label="Close" title="Close (Esc)" onClick={close} style={{ ...textButton, fontSize: 14, color: 'var(--ts)' }}>✕</button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {load.status === 'loading' && <div style={{ ...note, color: 'var(--tt)' }}>Loading the section…</div>}
        {load.status === 'error' && (
          <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--red)' }}>
            <span>Could not load the section</span>
            {load.detail && <span style={{ color: 'var(--ts)' }}>{load.detail}</span>}
            <button type="button" onClick={() => setAttempt((n) => n + 1)} style={textButton}>Retry</button>
          </div>
        )}
        {/* Review round 1: the daemon's note names the copy it read (a worktree, or the main checkout). */}
        {data?.note && <div style={{ ...note, color: 'var(--yellow)' }}>{data.note}</div>}
        {data?.kind === 'section' && (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.4, color: 'var(--tp)' }}>{data.heading}</div>
            <div ref={bodyRef} className="ledger-source-body">
              <Markdown source={data.markdown} />
            </div>
            {data.cut && <div style={note}>The section continues in the file.</div>}
          </>
        )}
        {data?.kind === 'outline' && (
          <>
            <div style={note}>No heading matched this item. The headings of the file:</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {data.headings.map((h, i) => (
                <li key={i} style={{ paddingLeft: (h.level - 1) * 14 }}>
                  <button type="button" onClick={() => setHeading(h.text)} style={{ ...textButton, fontSize: 12.5, textAlign: 'left' }}>{h.text}</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {data?.kind === 'file-only' && <div style={note}>{data.reason}</div>}
      </div>
    </section>
  );
}
