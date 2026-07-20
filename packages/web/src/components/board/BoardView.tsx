// The desktop thread board — full-bleed, replaces Workspace entirely (see App.tsx's `view`
// branch). Three real columns (Needs Help · Complete · Working), fixed order, the two you can
// clear on the left plus the one that's simply live — and a collapsed Resting RAIL on the right,
// NOT a fourth equal column. That's the headline change from
// docs/design/board-redesign/Board mode redesign.dc.html (the approved redesign canvas), Open #1:
// Settled already says Resting is never meant to be read, so its default state should cost one
// line per project, not a multi-hundred-card scroll — collapsing it *delivers* "quietest,
// narrowest column" rather than fighting it. It also removes the tall column that used to stretch
// the board and leave a ragged void beside the three short ones (Open #2) — see
// before-real-board.png for the problem this fixes. The rail's own layout/behaviour lives in
// RestingRail.tsx; this file only decides which cards reach it.
//
// The Threads ⇄ Board mode switch lives in TopBar rather than here — a switch rendered only
// inside the board could get you out but never in. Layout, proportions and the WAITING divider
// match the canvas literally — do not improvise a different treatment.
//
// Uses ONLY app-global `var(--color-*)` tokens (never `--tp`/`--ts`/`--elev`/`--acc`/`--border`/
// `--mono`, which are scoped to `:where(.overseer-root)` and resolve to nothing here) plus the
// two literal column accents (#e8b04b needs-help, #5A8DD6 complete) — the same rule BoardCard.tsx
// and MoveToMenu.tsx already follow. `--color-accent` is user-customisable (Working's own accent),
// so nothing here assumes it's green. The one exception is `WorkerLightbox` itself, wrapped in its
// own `.overseer-root` div below, per the plan's global constraints.

import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CaretDown, CheckCircle, MoonStars } from '@phosphor-icons/react';
import { useBoardData } from './useBoardData';
import { BoardCard } from './BoardCard';
import { MoveToMenu } from './MoveToMenu';
import { RestingRail } from './RestingRail';
import type { BoardCardModel, BoardColumn } from './boardColumn';
import { api } from '../../api/client';
import { useOverseer } from '../overseer/store';
import { WorkerLightbox } from '../overseer/components/WorkerLightbox';
import '../overseer/tokens.css';

// The three REAL columns, fixed order, widest-first: Needs Help is the loudest (the only one
// that blocks on a human), so it gets extra room (flex:1.35 vs 1). Resting is no longer part of
// this list — it renders as its own fixed-width rail (see RestingRail.tsx), not a fourth column.
type RealColumn = Exclude<BoardColumn, 'resting'>;
const REAL_COLUMNS: readonly RealColumn[] = ['needs_help', 'complete', 'working'];

const COLUMN_TITLE: Record<RealColumn, string> = {
  needs_help: 'Needs Help',
  complete: 'Complete',
  working: 'Working',
};

// Header text treatment, per the canvas: only Needs Help/Complete get an explicit hue — Working's
// header stays the default text colour, distinguished by opacity alone.
const COLUMN_HEADER_STYLE: Record<RealColumn, CSSProperties> = {
  needs_help: { color: '#e8b04b' },
  complete: { color: '#5A8DD6' },
  working: { color: 'var(--color-text-primary)', opacity: 0.85 },
};

// Canvas proportions (the BOARD BODY's flex row): Needs Help flex:1.35 — widest, it's the
// loudest — Complete/Working flex:1.
const COLUMN_FLEX: Record<RealColumn, number> = {
  needs_help: 1.35,
  complete: 1,
  working: 1,
};

// The same three accents chips use for their status dot — needs_help/complete get their literal
// hex, working gets the user-customisable accent token (never assumed green).
const CHIP_DOT_COLOR: Record<RealColumn, string> = {
  needs_help: '#e8b04b',
  complete: '#5A8DD6',
  working: 'var(--color-accent)',
};

// "Clear all" per the canvas: plain text, inheriting the Complete header's own colour/opacity
// treatment — the canvas's row has no color of its own, just font-weight/opacity/size overrides
// on top of the header's #5A8DD6.
const clearAllButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  padding: 0,
  fontWeight: 500,
  opacity: 0.6,
  fontSize: 9.5,
};

const chipStyle = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 28,
  padding: '0 11px',
  borderRadius: 999,
  fontSize: 12,
  whiteSpace: 'nowrap',
  flexShrink: 0,
  cursor: 'pointer',
  color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
  background: active ? 'var(--color-elevated)' : 'var(--color-pane)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: active ? 'var(--color-accent)' : 'var(--color-border)',
});

const allProjectsButtonStyle = (active: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  height: 30,
  padding: '0 12px',
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--color-border)',
  background: active ? 'var(--color-elevated)' : 'var(--color-pane)',
  color: 'var(--color-text-primary)',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  flexShrink: 0,
  fontFamily: 'inherit',
});

const projectMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 36,
  left: 0,
  zIndex: 20,
  minWidth: 220,
  maxHeight: 320,
  overflowY: 'auto',
  background: 'var(--color-elevated)',
  color: 'var(--color-text-primary)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--color-border)',
  borderRadius: 10,
  boxShadow: '0 20px 50px rgba(0,0,0,.5)',
  padding: 6,
};

const projectMenuRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '7px 10px',
  background: 'none',
  border: 'none',
  borderRadius: 7,
  color: 'var(--color-text-primary)',
  fontSize: 12.5,
  cursor: 'pointer',
  textAlign: 'left',
  fontFamily: 'inherit',
};

interface CardHandlers {
  onOpen: (card: BoardCardModel) => void;
  onAcknowledge: (terminalId: string) => void;
  onDismissInferred: (terminalId: string) => void;
  onOverride: (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => void;
}

// Open #5's "empty states that feel like a win, not a gap" — Needs Help's own empty state.
// Renders IN PLACE of that column's (necessarily empty) card list, never conditional on the other
// columns — the whole-board idle state below is the separate, stronger condition that replaces
// all three columns at once.
function NeedsHelpEmpty() {
  return (
    <div
      data-testid="board-needs-help-empty"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '36px 16px', gap: 4 }}
    >
      <CheckCircle size={34} weight="fill" color="var(--color-accent)" style={{ marginBottom: 6 }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>Nobody's waiting on you</div>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', maxWidth: 240, lineHeight: 1.5 }}>
        Every agent is either moving or done. This is the goal state — the to-do list is empty.
      </div>
    </div>
  );
}

// Open #5's other empty state: nothing in ANY of the three real columns. Replaces all three
// columns with one calm message rather than three separately-empty ones side by side — the
// Resting rail stays put beside it (per its own copy: "wake a resting thread").
function BoardIdleState({ restingCount }: { restingCount: number }) {
  return (
    <div
      data-testid="board-idle-state"
      style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '48px 20px', gap: 4, minHeight: 300 }}
    >
      <MoonStars size={30} color="var(--color-text-tertiary)" style={{ marginBottom: 6 }} />
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-text-primary)' }}>Nothing running</div>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', maxWidth: 300, lineHeight: 1.5 }}>
        All {restingCount} threads are resting. Start one from Threads, or wake a resting thread to put it back to work.
      </div>
    </div>
  );
}

function BoardColumnView({ column, cards, handlers }: { column: RealColumn; cards: BoardCardModel[]; handlers: CardHandlers }) {
  const live = cards.filter((c) => !c.pending);
  const pending = cards.filter((c) => c.pending);

  // Acknowledges every card currently in this column — only ever wired for Complete (see
  // render below). Per the spec: "opening a thread auto-acknowledges it" plus this explicit
  // Clear all on the column header are the two ways a Complete card reaches Resting.
  const clearAll = () => cards.forEach((c) => handlers.onAcknowledge(c.terminalId));

  const renderCard = (card: BoardCardModel) => (
    <MoveToMenu key={card.terminalId} terminalId={card.terminalId} onOverride={handlers.onOverride}>
      <BoardCard
        card={card}
        onOpen={() => handlers.onOpen(card)}
        onAcknowledge={handlers.onAcknowledge}
        onDismissInferred={handlers.onDismissInferred}
        onOverride={handlers.onOverride}
      />
    </MoveToMenu>
  );

  return (
    <div data-testid={`board-column-${column}`} style={{ flex: COLUMN_FLEX[column], minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', fontWeight: 700, fontSize: 10, letterSpacing: '.4px', ...COLUMN_HEADER_STYLE[column] }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{COLUMN_TITLE[column].toUpperCase()}</span>
          <span data-testid={`board-column-count-${column}`}>{cards.length}</span>
        </div>
        {column === 'complete' && cards.length > 0 && (
          <button type="button" onClick={clearAll} style={clearAllButtonStyle}>
            Clear all
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {column === 'needs_help' && cards.length === 0 ? (
          <NeedsHelpEmpty />
        ) : (
          <>
            {live.map(renderCard)}
            {column === 'working' && pending.length > 0 && (
              <div style={{ fontSize: 9.5, letterSpacing: '.5px', opacity: 0.4, padding: '0 8px 5px' }}>
                WAITING — RESUMES ON ITS OWN
              </div>
            )}
            {pending.map(renderCard)}
          </>
        )}
      </div>
    </div>
  );
}

// Every project with at least one NON-resting thread earns a filter chip (Open #6). A chip is a
// filter, and filtering to an all-resting project would yield an empty board — so a resting-only
// project earns no space above the fold; it's still reachable through the "All projects ▾"
// dropdown (see the header below), just not as a permanent chip. `topColumn` is the highest-
// priority column (needs_help > complete > working, the board's own left-to-right order) that
// project appears in — it drives the chip's status dot.
interface ChipProject { id: string; name: string; count: number; topColumn: RealColumn }

function computeChipProjects(
  rawColumns: Record<BoardColumn, BoardCardModel[]>,
  projects: { id: string; name: string }[],
): ChipProject[] {
  const byProject = new Map<string, { count: number; topColumn: RealColumn }>();
  for (const column of REAL_COLUMNS) {
    for (const card of rawColumns[column]) {
      const existing = byProject.get(card.projectId);
      if (existing) existing.count += 1;
      else byProject.set(card.projectId, { count: 1, topColumn: column });
    }
  }
  return projects
    .filter((p) => byProject.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, ...byProject.get(p.id)! }));
}

// Total thread count (every column, including Resting) per project — shown in the "All projects"
// dropdown, which lists EVERY project (unlike the chip strip, this includes resting-only ones).
function computeProjectTotals(rawColumns: Record<BoardColumn, BoardCardModel[]>): Map<string, number> {
  const totals = new Map<string, number>();
  for (const key of Object.keys(rawColumns) as BoardColumn[]) {
    for (const card of rawColumns[key]) totals.set(card.projectId, (totals.get(card.projectId) ?? 0) + 1);
  }
  return totals;
}

function filterColumns(
  columns: Record<BoardColumn, BoardCardModel[]>,
  projectFilter: string | null,
): Record<BoardColumn, BoardCardModel[]> {
  if (!projectFilter) return columns;
  const out = {} as Record<BoardColumn, BoardCardModel[]>;
  for (const key of Object.keys(columns) as BoardColumn[]) {
    out[key] = columns[key].filter((c) => c.projectId === projectFilter);
  }
  return out;
}

export function BoardView() {
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  // Always fold EVERY project, unfiltered — the chip strip and the "All projects" dropdown must
  // stay stable while a filter is applied (switching between two projects shouldn't make either
  // one's chip disappear). `columns` below is the client-side-filtered view actually rendered;
  // filtering after the fact rather than passing `projectFilter` into the hook a second time
  // avoids double-mounting the hook's own tab-loading effect for every project.
  const { columns: rawColumns, projects } = useBoardData(null);
  const columns = useMemo(() => filterColumns(rawColumns, projectFilter), [rawColumns, projectFilter]);

  const chipProjects = useMemo(() => computeChipProjects(rawColumns, projects), [rawColumns, projects]);
  const projectTotals = useMemo(() => computeProjectTotals(rawColumns), [rawColumns]);

  // Closes the "All projects" dropdown on an outside click — same pattern as MoveToMenu's popover.
  useEffect(() => {
    if (!projectMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!projectMenuRef.current?.contains(e.target as Node)) setProjectMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [projectMenuOpen]);

  const acknowledge = (terminalId: string) => { void api.setBoardState(terminalId, { acknowledged: true }); };
  // Per the design spec's card-movement table: dismissing an inferred ask means the heuristic
  // was wrong and the thread had in fact finished — it goes to Complete, not Resting.
  const dismissInferred = (terminalId: string) => { void api.setBoardState(terminalId, { override: 'complete' }); };
  const override = (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => {
    void api.setBoardState(terminalId, { override: target });
  };
  // "Clicking a card opens the thread over the board" (spec) — the existing WorkerLightbox is
  // the named precedent. Opening a Complete card is also how you acknowledge it ("opening a
  // thread auto-acknowledges it"). Also used by the Resting rail's expanded rows — a resting
  // card's column is never 'complete', so the acknowledge branch is simply inert there.
  const open = (card: BoardCardModel) => {
    useOverseer.getState().drillInto(card.terminalId);
    if (card.column === 'complete') acknowledge(card.terminalId);
  };

  const handlers: CardHandlers = { onOpen: open, onAcknowledge: acknowledge, onDismissInferred: dismissInferred, onOverride: override };

  // The stronger, whole-board condition Open #5 asks for: nothing in ANY of the three real
  // columns (whether because there's genuinely nothing, or everything is resting). Computed off
  // the FILTERED view, so it reacts to whichever project chip is active.
  const boardIdle = columns.needs_help.length === 0 && columns.complete.length === 0 && columns.working.length === 0;

  const selectProject = (id: string | null) => {
    setProjectFilter(id);
    setProjectMenuOpen(false);
  };

  return (
    <div data-testid="board-view" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-base)' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderWidth: 0, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--color-border)', flexShrink: 0 }}>
        {/* The Threads ⇄ Board switch lives in TopBar, not here: a switch rendered only
            inside the board can get you out but never in, leaving the board unreachable.
            TopBar sits directly above this header, so it reads the same either way. */}

        {/* "All projects ▾" — resets the filter AND opens a dropdown listing EVERY project
            (including resting-only ones, which never earn a chip below — Open #6's "the rest
            live behind the All projects ▾ control"). `aria-label` keeps the accessible name a
            plain "All projects" regardless of the visible count badge next to it. */}
        <div ref={projectMenuRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            type="button"
            aria-label="All projects"
            aria-pressed={projectFilter === null}
            aria-expanded={projectMenuOpen}
            onClick={() => { setProjectFilter(null); setProjectMenuOpen((o) => !o); }}
            style={allProjectsButtonStyle(projectFilter === null)}
          >
            All projects
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{projects.length}</span>
            <CaretDown size={10} color="var(--color-text-tertiary)" />
          </button>
          {projectMenuOpen && (
            <div data-testid="board-project-menu" style={projectMenuStyle}>
              {projects.map((p) => (
                <button key={p.id} type="button" onClick={() => selectProject(p.id)} style={projectMenuRowStyle}>
                  <span>{p.name}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{projectTotals.get(p.id) ?? 0}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--color-border)', flexShrink: 0 }} />

        {/* One row, always — never the two-row wrap the old chip strip left when 20 projects
            were all shown at once (Open #6). Only projects with non-resting activity get a chip
            here; it scrolls horizontally with an edge fade rather than wrapping. */}
        <div
          data-testid="board-project-chips"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            overflowX: 'auto',
            flex: 1,
            minWidth: 0,
            WebkitMaskImage: 'linear-gradient(90deg, #000 92%, transparent)',
            maskImage: 'linear-gradient(90deg, #000 92%, transparent)',
          }}
        >
          {chipProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-label={p.name}
              aria-pressed={projectFilter === p.id}
              onClick={() => setProjectFilter(p.id)}
              style={chipStyle(projectFilter === p.id)}
            >
              <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: CHIP_DOT_COLOR[p.topColumn], flexShrink: 0 }} />
              {p.name}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{p.count}</span>
            </button>
          ))}
        </div>
      </header>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 16px 26px', display: 'flex', alignItems: 'flex-start', gap: 20 }}>
        <div data-testid="board-columns" style={{ display: 'flex', alignItems: 'flex-start', gap: 20, flex: 1, minWidth: 0 }}>
          {boardIdle
            ? <BoardIdleState restingCount={columns.resting.length} />
            : REAL_COLUMNS.map((column) => (
                <BoardColumnView key={column} column={column} cards={columns[column]} handlers={handlers} />
              ))}
        </div>

        <RestingRail cards={columns.resting} onOpen={handlers.onOpen} />
      </div>

      <div className="overseer-root">
        <WorkerLightbox />
      </div>
    </div>
  );
}
