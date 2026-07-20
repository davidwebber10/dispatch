// The Resting rail — the redesign's headline change (Open #1 in
// docs/design/board-redesign/Board mode redesign.dc.html, the approved redesign canvas). Resting
// holds the large majority of every project's threads and, per Settled, is never meant to be
// read. So unlike the three real columns it does NOT render a scrolling stack of cards: it's a
// fixed-width (250px, flex-shrink:0) rail that defaults to a collapsed, one-line-per-project
// rollup ("Dispatch 176", "OS 21", …) and only reveals individual threads — still grouped by
// project, newest first, capped per group — once its own header is clicked open.
//
// This is what turns "quietest, narrowest column" from an aspiration into something the layout
// actually delivers (Open #1's reasoning card), and it's what removes the multi-hundred-card-tall
// column that used to stretch the board and leave a ragged void beside the three short ones
// (Open #2) — see before-real-board.png for the problem this fixes.
//
// Rows here are deliberately NOT <BoardCard/> (per the task brief) — they're a much quieter,
// one-line kind of row. Border/background colors are LONGHAND (borderWidth/Style/Color) rather
// than the `border` shorthand, same reason BoardCard.tsx gives: jsdom's CSS parser silently drops
// a shorthand containing var(--color-border), and real browsers are fine either way.

import { useState, type CSSProperties } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import type { BoardCardModel } from './boardColumn';
import { timeAgo } from '../../lib/time';

export interface RestingRailProps {
  /** Every resting card currently in view (already filtered to the active project chip, if any)
   * — sorted newest-first, the same convention every other column follows (see useBoardData.ts). */
  cards: BoardCardModel[];
  onOpen: (card: BoardCardModel) => void;
}

// Collapsed: how many project groups show before folding the rest into "+ N more projects" —
// the canvas shows 4 (Dispatch/OS/Salsify Catalogs/Europe 2026) before "+ 5 more projects".
const ROLLUP_VISIBLE_GROUPS = 4;
// Expanded: how many threads show per group before "N more in <project> ↓" — the brief's own
// "~3 threads per group expanded".
const GROUP_VISIBLE_CAP = 3;

// The exact fallback text boardColumn.ts's detailFor() emits for a resting card with no recorded
// outcome — mirrors BoardCard.tsx's own (private, unexported) RESTING_NEVER_STARTED constant, so
// a never-started thread reads "new" here too rather than a nonsensical `timeAgo` of its creation.
const NEVER_STARTED = 'new — no work yet';

interface Group {
  projectId: string;
  projectName: string;
  cards: BoardCardModel[];
}

// Grouped by project — the only axis you'd ever search a resting thread on (the canvas's own
// reasoning). Sorted by count descending (busiest project first, matching the canvas's
// Dispatch 176 / OS 21 / … order); project name breaks ties for a stable, deterministic render.
// `cards` arrives already newest-first overall, so bucketing by project preserves that order
// within each group too — no re-sort needed here.
function groupByProject(cards: BoardCardModel[]): Group[] {
  const map = new Map<string, Group>();
  for (const c of cards) {
    const g = map.get(c.projectId);
    if (g) g.cards.push(c);
    else map.set(c.projectId, { projectId: c.projectId, projectName: c.projectName, cards: [c] });
  }
  return Array.from(map.values()).sort(
    (a, b) => b.cards.length - a.cards.length || a.projectName.localeCompare(b.projectName),
  );
}

const railStyle: CSSProperties = {
  width: 250,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const headerButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '0 2px 2px',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const boxStyle: CSSProperties = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--color-border)',
  borderRadius: 10,
  background: 'var(--color-canvas)',
  padding: 6,
  opacity: 0.85,
};

const rollupRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '7px 9px',
  borderRadius: 7,
  fontSize: 12.5,
  color: 'var(--color-text-secondary)',
};

const moreProjectsRowStyle: CSSProperties = {
  padding: '7px 9px',
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
};

const footerCountStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 22,
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
};

const showAllButtonStyle: CSSProperties = {
  width: '100%',
  height: 32,
  marginTop: 2,
  border: 'none',
  borderTopWidth: 1,
  borderTopStyle: 'solid',
  borderTopColor: 'var(--color-border)',
  background: 'transparent',
  color: 'var(--color-text-secondary)',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const groupHeaderStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--color-text-tertiary)',
  padding: '8px 2px 2px',
};

const threadRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--color-border)',
  borderRadius: 8,
  padding: '8px 11px',
  opacity: 0.55,
  fontSize: 12.5,
  cursor: 'pointer',
};

const moreInGroupButtonStyle: CSSProperties = {
  height: 28,
  border: 'none',
  background: 'transparent',
  color: 'var(--color-text-tertiary)',
  fontSize: 11.5,
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
  padding: '0 2px',
  width: '100%',
};

export function RestingRail({ cards, onOpen }: RestingRailProps) {
  // Collapsed by default — Resting is never meant to be read (see file header).
  const [expanded, setExpanded] = useState(false);
  // Per-group "reveal the rest" state for the expanded view's own cap, keyed by projectId — lets
  // one busy group's "N more" grow without affecting any other group's cap.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  const groups = groupByProject(cards);
  const total = cards.length;

  const revealGroup = (projectId: string) => setOpenGroups((prev) => new Set(prev).add(projectId));

  return (
    <div data-testid="board-resting-rail" style={railStyle}>
      <button
        type="button"
        data-testid="board-resting-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
        style={headerButtonStyle}
      >
        <span style={{ fontSize: 11, letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--color-text-tertiary)' }}>
          Resting
        </span>
        <span data-testid="board-resting-total" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--color-text-tertiary)' }}>
          {total}
        </span>
        <div style={{ flex: 1 }} />
        <CaretDown size={12} color="var(--color-text-tertiary)" style={{ transform: expanded ? 'rotate(180deg)' : 'none' }} />
      </button>

      {!expanded && (
        <div data-testid="board-resting-collapsed" style={boxStyle}>
          {groups.length === 0 ? (
            <div style={{ padding: '16px 10px', textAlign: 'center', fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              Nothing resting
            </div>
          ) : (
            <>
              {groups.slice(0, ROLLUP_VISIBLE_GROUPS).map((g) => (
                <div key={g.projectId} data-testid={`board-resting-rollup-row-${g.projectId}`} style={rollupRowStyle}>
                  <span>{g.projectName}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{g.cards.length}</span>
                </div>
              ))}
              {groups.length > ROLLUP_VISIBLE_GROUPS && (
                <div style={moreProjectsRowStyle}>+ {groups.length - ROLLUP_VISIBLE_GROUPS} more projects</div>
              )}
              {/* Footer: total + "Show all →" — per the brief, shown alongside the grouped
                  rollup rather than as an alternate ("count only") treatment. */}
              <div style={{ borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--color-border)', marginTop: 4, paddingTop: 2 }}>
                <div style={{ textAlign: 'center', padding: '10px 10px 2px' }}>
                  <div style={footerCountStyle}>{total}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>threads at rest</div>
                </div>
                <button type="button" onClick={() => setExpanded(true)} style={showAllButtonStyle}>
                  Show all →
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {expanded && (
        <div data-testid="board-resting-expanded" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 470, overflow: 'auto' }}>
          {groups.length === 0 && (
            <div style={{ padding: '16px 4px', fontSize: 12, color: 'var(--color-text-tertiary)' }}>Nothing resting</div>
          )}
          {groups.map((g) => {
            const revealed = openGroups.has(g.projectId);
            const visible = revealed ? g.cards : g.cards.slice(0, GROUP_VISIBLE_CAP);
            const remaining = g.cards.length - visible.length;
            return (
              <div key={g.projectId} data-testid={`board-resting-group-${g.projectId}`}>
                <div style={groupHeaderStyle}>{g.projectName} · {g.cards.length}</div>
                {visible.map((card) => {
                  const age = card.detail === NEVER_STARTED ? 'new' : timeAgo(card.lastActivityAt);
                  return (
                    <div
                      key={card.terminalId}
                      data-testid="board-resting-thread-row"
                      style={threadRowStyle}
                      onClick={() => onOpen(card)}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{card.label}</span>
                      <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, fontSize: 10 }}>{age}</span>
                    </div>
                  );
                })}
                {remaining > 0 && (
                  <button type="button" onClick={() => revealGroup(g.projectId)} style={moreInGroupButtonStyle}>
                    {remaining} more in {g.projectName} ↓
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
