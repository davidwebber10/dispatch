import type { CSSProperties } from 'react';
import type { MobileViewMode } from '../../stores/settings';

/**
 * A ~52px-tall thumbnail of what a mobile view mode actually looks like — Threads as a flat
 * grey list, Board as amber/blue/green/grey bands, grouped in the order the board itself
 * prioritizes them (needs help → complete → working → resting; see
 * `components/board/boardColumn.ts`). This is the recognition affordance the settings picker
 * relies on instead of a labelled radio: see
 * docs/superpowers/specs/2026-07-20-thread-board-design.md "Placement, and the view-mode
 * setting". Kept standalone (rather than inlined in GeneralSection) so it is independently
 * testable and reusable if a second picker ever needs it.
 */

// Colors from the approved mockup — kept local to this file since it is the one place they're
// rendered as a picker thumbnail; BoardCard.tsx (built separately) owns the real board's colors.
const BAND_COLOR = {
  needs_help: '#e8b04b',
  complete: '#5A8DD6',
  working: 'var(--color-accent)',
  resting: 'var(--color-border)',
} as const;

type BoardBand = keyof typeof BAND_COLOR;

// Grouped top-to-bottom in board priority order. Two bars for the columns that "want you"
// (needs_help/complete) vs. one each for the columns that don't, so the thumbnail reads as
// bands rather than a random speckle even at 52px.
const BOARD_GROUPS: { column: BoardBand; count: number }[] = [
  { column: 'needs_help', count: 2 },
  { column: 'complete', count: 2 },
  { column: 'working', count: 1 },
  { column: 'resting', count: 1 },
];

const THREADS_BAR_COUNT = 6;
// Deliberately not any of the BAND_COLOR values — Threads must not "accidentally" carry a
// board accent color, which is the whole basis of the visual-distinctness test.
const THREADS_BAR_COLOR = 'var(--color-text-tertiary)';

const barBase: CSSProperties = { height: 5, borderRadius: 2, width: '100%', flexShrink: 0 };

export function ViewModeMiniature({ mode }: { mode: MobileViewMode }) {
  if (mode === 'threads') {
    return (
      <div
        role="img"
        aria-label="Threads view: a flat list of projects and threads"
        style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, width: '100%', height: 52, padding: '8px 10px', boxSizing: 'border-box' }}
      >
        {Array.from({ length: THREADS_BAR_COUNT }).map((_, i) => (
          <span key={i} data-testid="viewmode-bar" style={{ ...barBase, background: THREADS_BAR_COLOR }} />
        ))}
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label="Board view: threads grouped by whether they need you"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, width: '100%', height: 52, padding: '8px 10px', boxSizing: 'border-box' }}
    >
      {BOARD_GROUPS.map((g) => (
        <div key={g.column} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {Array.from({ length: g.count }).map((_, i) => (
            <span
              key={i}
              data-testid="viewmode-bar"
              data-band={g.column}
              style={{ ...barBase, background: BAND_COLOR[g.column] }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
