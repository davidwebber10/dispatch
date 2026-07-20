// Mobile board — the same cross-project model as the desktop board (BoardView.tsx), rendered as
// ONE VERTICAL SCROLL OF STACKED COLLAPSIBLE SECTIONS rather than side-by-side columns. This is
// option A from `.superpowers/brainstorm/65628-1784514698/content/mobile.html` — the approved
// mockup; the swipeable-columns and two-inboxes options shown alongside it were rejected. See
// docs/superpowers/specs/2026-07-20-thread-board-design.md, "Mobile — first-class, not a
// fallback": a phone can't show four columns side by side, so mobile keeps the MODEL (four
// buckets, same priority order) and drops the METAPHOR (parallel columns).
//
// Needs Help and Complete start expanded — the two buckets that want the human. Working and
// Resting start collapsed to a header + count. Every section's count renders regardless of
// expansion state: that is the entire point of this screen (answering "does anything need me?"
// without a gesture), so it must never be conditional on `isExpanded`.
//
// Uses only app-global var(--color-*) tokens (never --tp/--ts/--elev/--acc/--border/--mono,
// which are scoped to :where(.overseer-root) and resolve to nothing here) plus the mockup's own
// literal column colors, per the plan's global constraints — same rule BoardCard.tsx and
// ViewModeMiniature.tsx already follow, and this file reuses their exact palette.

import { useState } from 'react';
import { BoardCard } from './BoardCard';
import { MoveToMenu } from './MoveToMenu';
import { useBoardData } from './useBoardData';
import type { BoardColumn } from './boardColumn';
import { api } from '../../api/client';
import { Spinner } from '../common/Spinner';

// Same four literal colors as ViewModeMiniature.tsx / BoardCard.tsx's accents (kept local —
// each board-adjacent file owns its own copy rather than sharing an import, per their comments).
const BAND_COLOR: Record<BoardColumn, string> = {
  needs_help: '#e8b04b',
  complete: '#5A8DD6',
  working: 'var(--color-accent)',
  resting: 'var(--color-border)',
};

// Resting is deliberately the quietest section even while collapsed (it will hold the large
// majority of threads and is never meant to be read — see the spec's desktop section), so it
// gets a lower collapsed opacity than Working.
const COLLAPSED_OPACITY: Record<BoardColumn, number> = {
  needs_help: 0.65,
  complete: 0.65,
  working: 0.65,
  resting: 0.45,
};

const SECTIONS: { column: BoardColumn; label: string }[] = [
  { column: 'needs_help', label: 'NEEDS HELP' },
  { column: 'complete', label: 'COMPLETE' },
  { column: 'working', label: 'WORKING' },
  { column: 'resting', label: 'RESTING' },
];

// Needs Help and Complete open by default (the two columns that want the human); Working and
// Resting start collapsed. Per mobile.html option A, the human's choice — do not compromise this.
const INITIAL_EXPANDED: Record<BoardColumn, boolean> = {
  needs_help: true,
  complete: true,
  working: false,
  resting: false,
};

export interface BoardMobileProps {
  onOpenThread: (projectId: string, terminalId: string) => void;
}

export function BoardMobile({ onOpenThread }: BoardMobileProps) {
  const { columns, loading } = useBoardData(null);
  const [expanded, setExpanded] = useState<Record<BoardColumn, boolean>>(INITIAL_EXPANDED);

  const toggle = (column: BoardColumn) => setExpanded((e) => ({ ...e, [column]: !e[column] }));

  // Board-only state mutations — fire-and-forget against the daemon, same pattern as
  // PinnedThreadsView's setPinned: the WS status stream refreshes the store afterwards, so
  // there's nothing to await here and a failed request just leaves the row as it was.
  const acknowledge = (terminalId: string) => { void api.setBoardState(terminalId, { acknowledged: true }).catch(() => { /* best-effort */ }); };
  const dismissInferred = (terminalId: string) => { void api.setBoardState(terminalId, { override: 'complete' }).catch(() => { /* best-effort */ }); };
  const override = (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => {
    void api.setBoardState(terminalId, { override: target }).catch(() => { /* best-effort */ });
  };

  const totalCount = SECTIONS.reduce((n, s) => n + columns[s.column].length, 0);

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '2px 10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 2px 6px' }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>Board</span>
      </div>

      {loading && totalCount === 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={24} /></div>
      )}

      {SECTIONS.map(({ column, label }) => {
        const cards = columns[column];
        const isExpanded = expanded[column];
        return (
          <div key={column} data-testid={`board-section-${column}`}>
            <button
              type="button"
              data-testid={`board-section-toggle-${column}`}
              aria-expanded={isExpanded}
              onClick={() => toggle(column)}
              style={{
                display: 'flex',
                width: '100%',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '9px 4px 6px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: '.5px',
                color: isExpanded ? BAND_COLOR[column] : 'var(--color-text-secondary)',
                opacity: isExpanded ? 1 : COLLAPSED_OPACITY[column],
              }}
            >
              <span>{isExpanded ? '▾' : '▸'} {label}</span>
              <span>{cards.length}</span>
            </button>

            {isExpanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 6 }}>
                {cards.map((card) => (
                  <MoveToMenu key={card.terminalId} terminalId={card.terminalId} onOverride={override} trigger="longpress">
                    <BoardCard
                      card={card}
                      onOpen={(terminalId) => onOpenThread(card.projectId, terminalId)}
                      onAcknowledge={acknowledge}
                      onDismissInferred={dismissInferred}
                      onOverride={override}
                    />
                  </MoveToMenu>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
