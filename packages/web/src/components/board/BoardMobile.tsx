// Mobile board — the same cross-project model as the desktop board (BoardView.tsx), rendered as
// ONE VERTICAL SCROLL OF STACKED COLLAPSIBLE SECTIONS rather than side-by-side columns. This is
// option A from `.superpowers/brainstorm/65628-1784514698/content/mobile.html` — the approved
// mockup; the swipeable-columns and two-inboxes options shown alongside it were rejected. See
// docs/superpowers/specs/2026-07-20-thread-board-design.md, "Mobile — first-class, not a
// fallback": a phone can't show four columns side by side, so mobile keeps the MODEL (four
// buckets, same priority order) and drops the METAPHOR (parallel columns).
//
// Needs Help and Complete start expanded — the two buckets that want the human. Working and
// Resting start collapsed. Every section's count renders regardless of expansion state, AND (per
// "Open 7 — mobile" in docs/design/board-redesign/Board mode redesign.dc.html) lives a second
// time in a persistent 4-count bar ABOVE the whole stack — section headers can be collapsed, so
// counts can't only live there, or the entire point (answering "does anything need me?" without a
// gesture) breaks the moment you scroll past a collapsed header. The bar renders straight off
// `columns`, independent of `expanded`, so it is never conditional on anything a tap changes.
//
// Two more differences from the desktop board, both from that same "Open 7" section:
//   - Complete cards get swipe-to-acknowledge (SwipeRow, reused from the common Unpin swipe on
//     PinnedThreadsView — not reinvented here). It is wired on Complete ONLY: acknowledging is the
//     one board action that is both safe and one-directional (reversible, and real activity
//     un-clears it) — see the design doc's "Swipe = acknowledge, on Complete only" reasoning card.
//     Needs Help keeps its explicit Answer button so an unanswered ask can never be cleared by
//     accident, and Working/Resting have no swipe at all.
//   - Resting collapses to its count like before, but expanding it now shows a GROUPED ROLLUP —
//     one line per project — rather than hundreds of individual cards. Matches the desktop rail's
//     collapsed treatment (BoardView.tsx doesn't render this yet; the rollup here is mobile's own
//     copy of that same idea, grouped on `card.projectName`, which is already on `BoardCardModel`
//     for exactly this purpose).
//
// Uses only app-global var(--color-*) tokens (never --tp/--ts/--elev/--acc/--border/--mono,
// which are scoped to :where(.overseer-root) and resolve to nothing here) plus the mockup's own
// literal column colors, per the plan's global constraints — same rule BoardCard.tsx and
// ViewModeMiniature.tsx already follow, and this file reuses their exact palette. `--font-mono` is
// a real app-global token (theme.css, distinct from the forbidden scoped `--mono`), so the count
// bar's numerals use it for the same monospace treatment the mockup gives them.

import { useState } from 'react';
import { BoardCard } from './BoardCard';
import { MoveToMenu } from './MoveToMenu';
import { SwipeRow } from '../common/SwipeRow';
import { useBoardData } from './useBoardData';
import type { BoardCardModel, BoardColumn } from './boardColumn';
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

// Short labels for the persistent count bar — the mockup's own "Help / Done / Working / Rest"
// (Open 7), distinct from the section headers' full "NEEDS HELP / COMPLETE" etc. because the bar
// has to fit four tiles across one phone width.
const COUNT_BAR_LABEL: Record<BoardColumn, string> = {
  needs_help: 'Help',
  complete: 'Done',
  working: 'Working',
  resting: 'Rest',
};

// Needs Help and Complete open by default (the two columns that want the human); Working and
// Resting start collapsed. Per mobile.html option A, the human's choice — do not compromise this.
const INITIAL_EXPANDED: Record<BoardColumn, boolean> = {
  needs_help: true,
  complete: true,
  working: false,
  resting: false,
};

// The persistent bar's tiles are plain except Needs Help, which gets the same tinted/bordered
// emphasis BoardCard.tsx already gives a non-inferred needs_help card (identical rgba literals —
// derived from the same #e8b04b so the bar's "Help" tile reads as the same color as the section
// below it, not a second, slightly-off yellow).
const countTileStyle = (column: BoardColumn): { borderColor: string; background: string } =>
  column === 'needs_help'
    ? { borderColor: 'rgba(232,176,75,.55)', background: 'rgba(232,176,75,.07)' }
    : { borderColor: 'var(--color-border)', background: 'transparent' };

function CountBar({ columns }: { columns: Record<BoardColumn, BoardCardModel[]> }) {
  return (
    <div data-testid="board-count-bar" style={{ display: 'flex', gap: 6, padding: '2px 2px 12px' }}>
      {SECTIONS.map(({ column }) => (
        <div
          key={column}
          data-testid={`board-count-${column}`}
          style={{
            flex: 1,
            textAlign: 'center',
            padding: '8px 2px',
            borderRadius: 9,
            borderWidth: 1,
            borderStyle: 'solid',
            ...countTileStyle(column),
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 700, color: BAND_COLOR[column] }}>
            {columns[column].length}
          </div>
          <div style={{ fontSize: 9, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.04em', marginTop: 1 }}>
            {COUNT_BAR_LABEL[column]}
          </div>
        </div>
      ))}
    </div>
  );
}

// Resting's collapsed-then-expanded state shows one line per project rather than every card —
// see the file header. Sorted by count descending (the mockup's Dispatch 176 / OS 21 / … order),
// project name breaking ties for a stable, deterministic render.
function groupRestingByProject(cards: BoardCardModel[]): { projectName: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const c of cards) counts.set(c.projectName, (counts.get(c.projectName) ?? 0) + 1);
  return Array.from(counts, ([projectName, count]) => ({ projectName, count })).sort(
    (a, b) => b.count - a.count || a.projectName.localeCompare(b.projectName),
  );
}

const rollupRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '7px 9px',
  fontSize: 12.5,
  color: 'var(--color-text-secondary)',
} as const;

function RestingRollup({ cards }: { cards: BoardCardModel[] }) {
  const groups = groupRestingByProject(cards);
  return (
    <div
      data-testid="board-resting-rollup"
      style={{
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--color-border)',
        borderRadius: 10,
        background: 'var(--color-canvas)',
        padding: 6,
        opacity: 0.85,
      }}
    >
      {groups.length === 0 && (
        <div style={{ padding: '7px 9px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Nothing resting</div>
      )}
      {groups.map((g) => (
        <div key={g.projectName} data-testid={`board-resting-rollup-row-${g.projectName}`} style={rollupRowStyle}>
          <span>{g.projectName}</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{g.count}</span>
        </div>
      ))}
    </div>
  );
}

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

  const renderCard = (card: BoardCardModel) => {
    const boardCard = (
      <BoardCard
        card={card}
        onOpen={(terminalId) => onOpenThread(card.projectId, terminalId)}
        onAcknowledge={acknowledge}
        onDismissInferred={dismissInferred}
        onOverride={override}
      />
    );
    return (
      <MoveToMenu key={card.terminalId} terminalId={card.terminalId} onOverride={override} trigger="longpress">
        {card.column === 'complete' ? (
          <SwipeRow actionLabel="Acknowledge" actionColor={BAND_COLOR.complete} onAction={() => acknowledge(card.terminalId)}>
            {boardCard}
          </SwipeRow>
        ) : (
          boardCard
        )}
      </MoveToMenu>
    );
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '2px 10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 2px 6px' }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>Board</span>
      </div>

      {/* Persistent 4-count bar — always renders straight off `columns`, never gated on
          `expanded`, so all four counts are visible with zero gestures (see file header). */}
      <CountBar columns={columns} />

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
              column === 'resting'
                ? <RestingRollup cards={cards} />
                : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 6 }}>
                    {cards.map(renderCard)}
                  </div>
                )
            )}
          </div>
        );
      })}
    </div>
  );
}
