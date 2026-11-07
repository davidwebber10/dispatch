import type { CSSProperties } from 'react';

/**
 * The phone header's controls share one box (2026-11-05): Previews, the usage chip, the alert bell
 * and the CLI ⇄ Pretty switch were 30-36 px tall with three different borders. A segmented
 * control (bell, switch) is this box with HEADER_INNER segments inside.
 */
export const HEADER_H = 36;
export const HEADER_BOX: CSSProperties = {
  height: HEADER_H, flexShrink: 0, boxSizing: 'border-box',
  // Bare (2026-11-06, header option C): no fill, no outline (2026-11-07: a usage warning colours
  // only the rings, never an outline). The transparent border keeps the size the same.
  background: 'transparent', border: '1px solid transparent', borderRadius: 'var(--radius-md)',
};
/** Padding of a segmented header control, and its segments' height (36 - 2 border - 2 x 3 padding). */
export const HEADER_PAD = 3;
export const HEADER_INNER = HEADER_H - 2 - 2 * HEADER_PAD;
