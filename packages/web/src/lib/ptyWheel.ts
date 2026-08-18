/** SGR mouse wheel ticks (DECSET 1006). Grok ignores these while its prompt is focused. */
export const WHEEL_UP = '\x1b[<64;1;1M';
export const WHEEL_DOWN = '\x1b[<65;1;1M';

/** Page Up/Down — Grok scrolls these even while the ordinary prompt is focused. */
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';

/** One PageUp/PageDown per this many pixels. A flick of ~80px is one page, not a flood. */
export const PAGE_STEP_PX = 80;

export function isAltBuffer(type: string | undefined): boolean {
  return type === 'alternate';
}

/** Grok is a TUI even when it has not entered the alternate buffer yet. */
export function shouldPtyScroll(bufferType: string | undefined, harnessType: string | undefined): boolean {
  return isAltBuffer(bufferType) || harnessType === 'grok';
}

function consumeTicks(accPx: number, deltaPx: number, stepPx: number, up: string, down: string): { accPx: number; seq: string } {
  const h = stepPx > 0 ? stepPx : 17;
  let acc = accPx + deltaPx;
  const ticks = Math.trunc(acc / h);
  acc -= ticks * h;
  if (ticks === 0) return { accPx: acc, seq: '' };
  return { accPx: acc, seq: (ticks > 0 ? down : up).repeat(Math.abs(ticks)) };
}

/**
 * Turn a pixel swipe into whole-row mouse-wheel ticks.
 * Same sign as TerminalTab's scrollByPx: finger-down (see older) is negative → wheel up.
 */
export function consumeWheelTicks(accPx: number, deltaPx: number, rowHeight: number): { accPx: number; seq: string } {
  return consumeTicks(accPx, deltaPx, rowHeight, WHEEL_UP, WHEEL_DOWN);
}

/** Same sign as consumeWheelTicks, but emits Page Up/Down (works with Grok's prompt focused). */
export function consumePageTicks(accPx: number, deltaPx: number, stepPx = PAGE_STEP_PX): { accPx: number; seq: string } {
  return consumeTicks(accPx, deltaPx, stepPx, PAGE_UP, PAGE_DOWN);
}
