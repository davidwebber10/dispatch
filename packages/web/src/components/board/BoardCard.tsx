// Renders one BoardCardModel — the card every board column stacks. Purely presentational: data
// in, callbacks out, no store reads and no API calls, so it can be exercised in tests without a
// daemon. Visual treatment matches `.superpowers/brainstorm/65628-1784514698/content/columns-v7.html`
// (the approved mockup) literally — borders, tints, opacities, marker glyphs, and the order lines
// appear in. Uses only app-global `var(--color-*)` tokens (never `--tp`/`--elev`/`--acc`/etc,
// which are scoped to `:where(.overseer-root)` and resolve to nothing here) plus the mockup's own
// literal hex/rgba values for the column accents, per the plan's global constraints.
//
// Border/background colors are set as LONGHAND style props (borderWidth/borderStyle/borderColor)
// rather than the `border` shorthand: jsdom's CSS parser silently drops a shorthand containing
// var(--color-border) (Resting's border), and real browsers are fine either way, so longhand is
// strictly safer with no visual cost.
//
// `onOverride` is accepted (per the architecture — Task 4/7 build the "Move to" affordance that
// will eventually invoke it) but is not wired to a control here: the mockup shows no such control
// on any card, and the plan's Task 7 owns building that surface in its own component. Leaving it
// unwired here rather than inventing a look is the deliberate choice — see the Task 3 report.

import type { CSSProperties, MouseEvent } from 'react';
import type { BoardCardModel } from './boardColumn';

export interface BoardCardProps {
  card: BoardCardModel;
  onOpen: (terminalId: string) => void;
  onAcknowledge: (terminalId: string) => void;
  onDismissInferred: (terminalId: string) => void;
  onOverride: (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => void;
}

// The exact fallback text `boardColumn.ts`'s detailFor() emits for a Resting card with no
// recorded outcome. Only a REAL outcome gets the ✓ prefix (matches the mockup: "Codex Pretty
// transport" gets "✓ shipped v2.1.0 · 3d", "Kanban board" gets a bare "new — no work yet").
const RESTING_NEVER_STARTED = 'new — no work yet';

// A blocked card's line, composed the same way needs_help wraps its question in quotes (below):
// `card.blocker` is only ever set (even to '') for a declared-blocked pending Working card —
// undefined means this pending card is queued/scheduled, not blocked, so it keeps the plain
// `card.detail` line untouched. '' means blocked was declared with no text supplied, which gets
// the bare fallback rather than empty quotes.
function workingDetail(card: BoardCardModel): string {
  if (card.blocker === undefined) return card.detail;
  return card.blocker ? `behind "${card.blocker}"` : 'blocked';
}

function appearance(card: BoardCardModel): CSSProperties {
  switch (card.column) {
    case 'needs_help':
      return card.inferred
        ? { borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(232,176,75,.3)', background: 'rgba(232,176,75,.03)' }
        : { borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(232,176,75,.55)', background: 'rgba(232,176,75,.07)' };
    case 'complete':
      return { borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(90,141,214,.5)', background: 'rgba(90,141,214,.06)' };
    case 'working':
      return card.pending
        ? { borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(128,128,128,.4)', opacity: 0.62 }
        : { borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(62,207,106,.5)', background: 'rgba(62,207,106,.05)' };
    case 'resting':
      return { borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--color-border)', opacity: 0.55 };
  }
}

const controlBase: CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

const answerButtonStyle: CSSProperties = {
  ...controlBase,
  border: '1px solid rgba(232,176,75,.6)',
  borderRadius: 5,
  padding: '2px 9px',
};

// Visually subordinate to Answer — grey, not amber — because an inferred ask is a guess, not a
// declared question; "Open" just goes and looks, it doesn't promise an answer is owed.
const openButtonStyle: CSSProperties = {
  ...controlBase,
  border: '1px solid rgba(128,128,128,.4)',
  borderRadius: 5,
  padding: '2px 9px',
};

const dismissButtonStyle: CSSProperties = {
  ...controlBase,
  border: 'none',
  opacity: 0.5,
  padding: 0,
};

const checkboxButtonStyle: CSSProperties = {
  ...controlBase,
  border: 'none',
  opacity: 0.6,
  fontSize: 15,
  padding: 0,
  alignSelf: 'flex-start',
};

export function BoardCard({ card, onOpen, onAcknowledge, onDismissInferred }: BoardCardProps) {
  const open = () => onOpen(card.terminalId);

  // Buttons stop propagation so a click on Answer/Open/Dismiss/Acknowledge fires exactly the one
  // callback it names — never also bubbling into the card-level onOpen. This is what makes the
  // "fires from its own control, and only its own" test guarantee hold.
  const stop = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const isComplete = card.column === 'complete';
  const hasRestingOutcome = card.column === 'resting' && card.detail !== RESTING_NEVER_STARTED;

  return (
    <div
      data-testid="board-card"
      onClick={open}
      style={{
        ...appearance(card),
        borderRadius: 'var(--radius-md)',
        padding: 9,
        fontSize: 11.5,
        color: 'var(--color-text-primary)',
        cursor: 'pointer',
        display: isComplete ? 'flex' : 'block',
        gap: isComplete ? 8 : undefined,
      }}
    >
      <div style={{ flex: isComplete ? 1 : undefined, minWidth: 0 }}>
        <div style={{ opacity: 0.5, fontSize: 10 }}>{card.projectName}</div>
        <div style={{ fontWeight: 600 }}>
          {card.label}
          {card.inferred && <span style={{ opacity: 0.55 }}> ~</span>}
        </div>

        {card.column === 'needs_help' && (
          <div style={{ opacity: 0.85, marginTop: 3, fontStyle: 'italic' }}>&quot;{card.detail}&quot;</div>
        )}
        {card.column === 'complete' && (
          <div style={{ marginTop: 3, color: '#7ba7e0' }}>✓ {card.detail}</div>
        )}
        {card.column === 'working' && (
          <div style={{ marginTop: 3, color: card.pending ? undefined : 'var(--color-accent)' }}>
            {card.pending ? '◌' : '●'} {workingDetail(card)}
          </div>
        )}
        {card.column === 'resting' && (
          <div style={{ marginTop: 3, opacity: 0.6 }}>
            {hasRestingOutcome ? `✓ ${card.detail}` : card.detail}
          </div>
        )}

        {card.column === 'needs_help' && !card.inferred && (
          <div style={{ marginTop: 7 }}>
            <button type="button" style={answerButtonStyle} onClick={stop(open)}>
              Answer
            </button>
          </div>
        )}
        {card.column === 'needs_help' && card.inferred && (
          <div style={{ marginTop: 7, display: 'flex', gap: 6, alignItems: 'center' }}>
            <button type="button" style={openButtonStyle} onClick={stop(open)}>
              Open
            </button>
            <button
              type="button"
              aria-label="Dismiss"
              style={dismissButtonStyle}
              onClick={stop(() => onDismissInferred(card.terminalId))}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {isComplete && (
        <button
          type="button"
          aria-label="Acknowledge"
          style={checkboxButtonStyle}
          onClick={stop(() => onAcknowledge(card.terminalId))}
        >
          ☐
        </button>
      )}
    </div>
  );
}
