// Renders one BoardCardModel — the card every board column stacks. Purely presentational: data
// in, callbacks out, no store reads and no API calls, so it can be exercised in tests without a
// daemon. Visual treatment follows `docs/design/board-redesign/Board mode redesign.dc.html` (the
// approved redesign canvas) — one card, four volumes:
//
//   - Needs Help  — loudest: the question verbatim, italic + quoted, clamped to 2 lines.
//   - Complete    — an acknowledgement: a card-owned ✓ plus a 1-line outcome.
//   - Working     — terse: a single-line live status (`Running · 2m`, `◌ queued`, …).
//   - Resting     — quietest: collapses to ONE line (label + a short age), no detail paragraph
//                   at all, at the card's existing ~55% opacity (see appearance()).
//
// Same anatomy, opposite volume — the fix for a board whose detail line used to render an
// agent's entire summary at equal loudness in every column (see `before-real-board.png`).
//
// Uses only app-global `var(--color-*)` tokens (never `--tp`/`--elev`/`--acc`/etc, which are
// scoped to `:where(.overseer-root)` and resolve to nothing here) plus the design's own literal
// hex/rgba values for the column accents.
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
import { timeAgo } from '../../lib/time';

export interface BoardCardProps {
  card: BoardCardModel;
  onOpen: (terminalId: string) => void;
  onAcknowledge: (terminalId: string) => void;
  onDismissInferred: (terminalId: string) => void;
  onOverride: (terminalId: string, target: 'needs_help' | 'complete' | 'resting') => void;
}

// The exact fallback text `boardColumn.ts`'s detailFor() emits for a Resting card with no
// recorded outcome — the only signal BoardCard has, short of a dedicated field, that a thread
// never ran a turn. Drives the "new" age label below rather than a computed `timeAgo`.
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

// Open #8A — the ✓✓ bug, designed out. The column owns the tick, never the agent's own text: a
// declared/inferred `done:`-flavored summary that ALSO leads with a check glyph must not survive
// into a second, agent-supplied tick sitting next to the card's own. Strips any leading check
// glyph (✓/✔/☑) or a leading `done:` (case-insensitive) — plus surrounding whitespace — and keeps
// stripping until none remains, so even a doubled/duplicated prefix can't survive the pass. Pure
// and exported so the strip rule is unit-tested directly, independent of rendering.
const LEADING_CHECK_RE = /^(?:[✓✔☑]|done:)\s*/i;

export function stripLeadingCheckmark(summary: string): string {
  let s = summary.trim();
  while (LEADING_CHECK_RE.test(s)) {
    s = s.replace(LEADING_CHECK_RE, '').trim();
  }
  return s;
}

// `-webkit-line-clamp` needs `display:-webkit-box` + `-webkit-box-orient:vertical` alongside it —
// the exact trio the design canvas uses. Volumes differ only in how many lines survive, and the
// values come from the canvas itself: Needs Help's question and Complete's outcome both get 2,
// Working's status line gets 1 (it is terse by construction — `Running · 2m`, `◌ queued`).
// Real outcome summaries run long (see docs/design/board-redesign/before-real-board.png), so one
// line truncates them mid-thought while two usually carries the whole result.
function clampLines(lines: number): CSSProperties {
  return { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines, overflow: 'hidden' };
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
  const isResting = card.column === 'resting';
  // "new" beats a computed age for a thread with no recorded outcome — timeAgo(lastActivityAt)
  // would otherwise report the age of the terminal's *creation*, which reads as an age when the
  // honest statement is "nothing ever ran here".
  const restingNeverStarted = isResting && card.detail === RESTING_NEVER_STARTED;
  const restingAge = restingNeverStarted ? 'new' : timeAgo(card.lastActivityAt);

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
      {isResting ? (
        // Quietest volume: the outer card already carries ~55% opacity (see appearance()) — the
        // content itself collapses to one line, label plus age, with no detail paragraph and no
        // project tag (the project is the axis a rollup groups by, not something a single
        // resting card needs to repeat).
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
            {card.label}
          </span>
          <span style={{ color: 'var(--color-text-tertiary)', flexShrink: 0, fontSize: 10 }}>{restingAge}</span>
        </div>
      ) : (
        <div style={{ flex: isComplete ? 1 : undefined, minWidth: 0 }}>
          <div style={{ opacity: 0.5, fontSize: 10 }}>{card.projectName}</div>
          <div style={{ fontWeight: 600 }}>
            {card.label}
            {card.inferred && <span style={{ opacity: 0.55 }}> ~</span>}
          </div>

          {card.column === 'needs_help' && (
            <div style={{ opacity: 0.85, marginTop: 3, fontStyle: 'italic', ...clampLines(2) }}>
              &quot;{card.detail}&quot;
            </div>
          )}
          {card.column === 'complete' && (
            <div style={{ marginTop: 3, color: 'var(--color-text-secondary)', ...clampLines(2) }}>
              <span style={{ color: '#5A8DD6', fontWeight: 700 }}>✓</span> {stripLeadingCheckmark(card.detail)}
            </div>
          )}
          {card.column === 'working' && (
            <div style={{ marginTop: 3, color: card.pending ? undefined : 'var(--color-accent)', ...clampLines(1) }}>
              {card.pending ? '◌' : '●'} {workingDetail(card)}
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
      )}

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
