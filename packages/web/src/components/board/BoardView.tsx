// The desktop thread board — full-bleed, replaces Workspace entirely (see App.tsx's `view`
// branch and docs/superpowers/specs/2026-07-20-thread-board-design.md's "Placement" section).
// Four columns, fixed order (Needs Help · Complete · Working · Resting — the two you can clear
// on the left, the two you can ignore on the right), plus a header carrying the project filter
// chips (`All projects` default). The Threads ⇄ Board mode switch lives in TopBar rather than
// here — a switch rendered only inside the board could get you out but never in. Layout, proportions and
// the WAITING divider match `.superpowers/brainstorm/65628-1784514698/content/columns-v7.html`
// literally — do not improvise a different treatment.
//
// Uses ONLY app-global `var(--color-*)` tokens (never `--tp`/`--ts`/`--elev`/`--acc`/etc, which
// are scoped to `:where(.overseer-root)` and resolve to nothing outside Overseer). The one
// exception is `WorkerLightbox` itself, which IS built on those scoped vars — it is wrapped in
// its own `.overseer-root` div below, per the plan's global constraints.

import type { CSSProperties } from 'react';
import { useState } from 'react';
import { useBoardData } from './useBoardData';
import { BoardCard } from './BoardCard';
import type { BoardCardModel, BoardColumn } from './boardColumn';
import { api } from '../../api/client';
import { useUI } from '../../stores/ui';
import { useOverseer } from '../overseer/store';
import { WorkerLightbox } from '../overseer/components/WorkerLightbox';
import '../overseer/tokens.css';

const COLUMN_ORDER: readonly BoardColumn[] = ['needs_help', 'complete', 'working', 'resting'];

const COLUMN_TITLE: Record<BoardColumn, string> = {
  needs_help: 'Needs Help',
  complete: 'Complete',
  working: 'Working',
  resting: 'Resting',
};

// Header text treatment, per the mockup: only Needs Help/Complete get an explicit hue —
// Working/Resting headers stay the default text colour, distinguished by opacity alone.
const COLUMN_HEADER_STYLE: Record<BoardColumn, CSSProperties> = {
  needs_help: { color: '#e8b04b' },
  complete: { color: '#5A8DD6' },
  working: { color: 'var(--color-text-primary)', opacity: 0.85 },
  resting: { color: 'var(--color-text-primary)', opacity: 0.55 },
};

// Resting is deliberately the narrowest column — it holds the large majority of threads and is
// never meant to be read (mockup: flex:.85 vs flex:1 for the other three).
const COLUMN_FLEX: Record<BoardColumn, number> = {
  needs_help: 1,
  complete: 1,
  working: 1,
  resting: 0.85,
};


const chipStyle = (active: boolean): CSSProperties => ({
  padding: '4px 11px',
  borderRadius: 999,
  fontSize: 11.5,
  cursor: 'pointer',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  background: active ? 'var(--color-elevated)' : 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
});

interface CardHandlers {
  onOpen: (card: BoardCardModel) => void;
  onAcknowledge: (terminalId: string) => void;
  onDismissInferred: (terminalId: string) => void;
  onOverride: (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => void;
}

function BoardColumnView({ column, cards, handlers }: { column: BoardColumn; cards: BoardCardModel[]; handlers: CardHandlers }) {
  const live = cards.filter((c) => !c.pending);
  const pending = cards.filter((c) => c.pending);

  return (
    <div data-testid={`board-column-${column}`} style={{ flex: COLUMN_FLEX[column], minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 8px', fontWeight: 700, fontSize: 10, letterSpacing: '.4px', ...COLUMN_HEADER_STYLE[column] }}>
        <span>{COLUMN_TITLE[column].toUpperCase()}</span>
        <span data-testid={`board-column-count-${column}`}>{cards.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {live.map((card) => (
          <BoardCard
            key={card.terminalId}
            card={card}
            onOpen={() => handlers.onOpen(card)}
            onAcknowledge={handlers.onAcknowledge}
            onDismissInferred={handlers.onDismissInferred}
            onOverride={handlers.onOverride}
          />
        ))}
        {column === 'working' && pending.length > 0 && (
          <div style={{ fontSize: 9.5, letterSpacing: '.5px', opacity: 0.4, padding: '0 8px 5px' }}>
            WAITING — RESUMES ON ITS OWN
          </div>
        )}
        {pending.map((card) => (
          <BoardCard
            key={card.terminalId}
            card={card}
            onOpen={() => handlers.onOpen(card)}
            onAcknowledge={handlers.onAcknowledge}
            onDismissInferred={handlers.onDismissInferred}
            onOverride={handlers.onOverride}
          />
        ))}
      </div>
    </div>
  );
}

export function BoardView() {
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const { columns, projects } = useBoardData(projectFilter);

  const acknowledge = (terminalId: string) => { void api.setBoardState(terminalId, { acknowledged: true }); };
  // Per the design spec's card-movement table: dismissing an inferred ask means the heuristic
  // was wrong and the thread had in fact finished — it goes to Complete, not Resting.
  const dismissInferred = (terminalId: string) => { void api.setBoardState(terminalId, { override: 'complete' }); };
  const override = (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => {
    void api.setBoardState(terminalId, { override: target });
  };
  // "Clicking a card opens the thread over the board" (spec) — the existing WorkerLightbox is
  // the named precedent. Opening a Complete card is also how you acknowledge it ("opening a
  // thread auto-acknowledges it").
  const open = (card: BoardCardModel) => {
    useOverseer.getState().drillInto(card.terminalId);
    if (card.column === 'complete') acknowledge(card.terminalId);
  };

  const handlers: CardHandlers = { onOpen: open, onAcknowledge: acknowledge, onDismissInferred: dismissInferred, onOverride: override };

  return (
    <div data-testid="board-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-base)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '9px 14px', borderBottom: '1px solid var(--color-border)', flexShrink: 0, flexWrap: 'wrap' }}>
        {/* The Threads ⇄ Board switch lives in TopBar, not here: a switch rendered only
            inside the board can get you out but never in, leaving the board unreachable.
            TopBar sits directly above this header, so it reads the same either way. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" aria-pressed={projectFilter === null} onClick={() => setProjectFilter(null)} style={chipStyle(projectFilter === null)}>
            All projects
          </button>
          {projects.map((p) => (
            <button key={p.id} type="button" aria-pressed={projectFilter === p.id} onClick={() => setProjectFilter(p.id)} style={chipStyle(projectFilter === p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </header>

      <div data-testid="board-columns" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 10, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {COLUMN_ORDER.map((column) => (
          <BoardColumnView key={column} column={column} cards={columns[column]} handlers={handlers} />
        ))}
      </div>

      <div className="overseer-root">
        <WorkerLightbox />
      </div>
    </div>
  );
}
