// Overseer — ledger chips in the chat (pinned card spec 2026-10-08, Unit 9).
//
// On the Control Plane screen every ledger number that the project's ledger knows ("N17") shows as
// a chip with its question: overseer replies (markdown, through <Markdown ledger>), the user's own
// messages, the agency notice pills and the report_status cards (plain text, <LedgerChipText>).
// The index comes from the shown project's pinned card only, so a chip never uses another
// project's ledger. A chip click opens the item on the card — the right pane's Details tab on
// desktop, the Work tab on mobile — or, for an item the card does not show (answered long ago), a
// small popover with its question, status and answer.

import { useEffect, useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { useProjects } from '../../../stores/projects';
import { useUI } from '../../../stores/ui';
import { useLedgerCard } from '../../../stores/ledgerCard';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { chipLabel, splitLedgerRefs, type LedgerChips, type LedgerIndexEntry } from '../../../lib/ledgerRefs';
import { ledgerSectionOf, STATUS_WORD } from '../ledger';
import { useOverseer } from '../store';

/** Open a ledger item from a chip: on the card when it is there, else in the popover at `anchor`. */
export function openLedgerRef(projectId: string, seq: number, anchor: { x: number; y: number }, opts: { mobile: boolean }): void {
  const card = useLedgerCard.getState().byProject[projectId]?.card;
  if (!card || ledgerSectionOf(card, seq) === null) {
    useLedgerCard.getState().setPopover({ projectId, seq, ...anchor });
    return;
  }
  if (opts.mobile) {
    useOverseer.getState().setMobileTab('work');
  } else {
    const ui = useUI.getState();
    ui.setRightCollapsed(false);
    ui.setInspectorTab('details');
  }
  // The card unfolds the item's section, opens it as a full card and scrolls to it (LedgerCard).
  useLedgerCard.getState().setFocus({ projectId, seq });
}

/** The shown project's chip index and click handler, or undefined while its card has not loaded. */
export function useLedgerChips(): LedgerChips | undefined {
  const projectId = useProjects((s) => s.activeId);
  const card = useLedgerCard((s) => (projectId ? s.byProject[projectId]?.card ?? null : null));
  const mobile = useIsMobile();
  return useMemo(() => {
    if (!projectId || !card?.index.length) return undefined;
    return {
      index: new Map(card.index.map((e) => [e.seq, e] as const)),
      onChip: (seq: number, anchor: { x: number; y: number }) => openLedgerRef(projectId, seq, anchor, { mobile }),
    };
  }, [projectId, card, mobile]);
}

function LedgerChip({ entry, onChip }: { entry: LedgerIndexEntry; onChip: LedgerChips['onChip'] }) {
  // A chip may sit inside a clickable notice pill: its click is the chip's alone.
  const open = (e: MouseEvent<HTMLSpanElement>) => { e.stopPropagation(); onChip(entry.seq, { x: e.clientX, y: e.clientY }); };
  const onKey = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    onChip(entry.seq, { x: r.left, y: r.bottom });
  };
  return (
    <span className="ledger-chip" data-ledger-chip={entry.seq} role="button" tabIndex={0} title={entry.text} onClick={open} onKeyDown={onKey}>
      {chipLabel(entry.seq, entry.text)}
    </span>
  );
}

/** Plain text with a chip for every known ledger number (never inside a code span or block). */
export function LedgerChipText({ text, ledger }: { text: string; ledger?: LedgerChips }) {
  if (!ledger) return <>{text}</>;
  const parts = splitLedgerRefs(text, (seq) => ledger.index.has(seq));
  return <>{parts.map((p, i) => (typeof p === 'string' ? p : <LedgerChip key={i} entry={ledger.index.get(p.seq)!} onChip={ledger.onChip} />))}</>;
}

const POPOVER_WIDTH = 300;

/** The popover of a chip whose item is not on the card. Escape or a click outside closes it. */
export function LedgerRefPopover() {
  const popover = useLedgerCard((s) => s.popover);
  const entry = useLedgerCard((s) => (s.popover ? s.byProject[s.popover.projectId]?.card?.index.find((e) => e.seq === s.popover!.seq) : undefined));
  useEffect(() => {
    if (!popover) return;
    const close = () => useLedgerCard.getState().setPopover(null);
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onDown = (e: globalThis.MouseEvent) => { if (!(e.target as Element | null)?.closest?.('[data-ledger-popover]')) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [popover]);
  if (!popover || !entry) return null;
  const left = Math.max(8, Math.min(popover.x, window.innerWidth - POPOVER_WIDTH - 8));
  return (
    <div
      role="dialog"
      aria-label={`N${entry.seq}`}
      data-ledger-popover
      style={{
        position: 'fixed', left, top: popover.y + 12, width: POPOVER_WIDTH, zIndex: 50,
        display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 9,
        background: 'var(--elev)', border: '1px solid var(--border)', boxShadow: '0 10px 28px -8px rgba(0,0,0,.7)',
        fontSize: 12.5, lineHeight: 1.45, color: 'var(--tp)',
      }}
    >
      <div style={{ fontWeight: 600 }}>{`N${entry.seq} · ${entry.text}`}</div>
      <div style={{ fontSize: 11.5, color: 'var(--ts)' }}>{STATUS_WORD[entry.status]}</div>
      {entry.answer && (
        <div style={{ fontSize: 12, color: 'var(--ts)' }}>
          <span style={{ fontWeight: 600, color: 'var(--tp)' }}>Answer:</span> <span>{`"${entry.answer}"`}</span>
        </div>
      )}
    </div>
  );
}
