/** SGR mouse wheel ticks (DECSET 1006). Grok's TUI listens for these. */
export const WHEEL_UP = '\x1b[<64;1;1M';
export const WHEEL_DOWN = '\x1b[<65;1;1M';

export function isAltBuffer(type: string | undefined): boolean {
  return type === 'alternate';
}

/**
 * Turn a pixel swipe into whole-row mouse-wheel ticks.
 * Same sign as TerminalTab's scrollByPx: finger-down (see older) is negative → wheel up.
 */
export function consumeWheelTicks(accPx: number, deltaPx: number, rowHeight: number): { accPx: number; seq: string } {
  const h = rowHeight > 0 ? rowHeight : 17;
  let acc = accPx + deltaPx;
  const ticks = Math.trunc(acc / h);
  acc -= ticks * h;
  if (ticks === 0) return { accPx: acc, seq: '' };
  return { accPx: acc, seq: (ticks > 0 ? WHEEL_DOWN : WHEEL_UP).repeat(Math.abs(ticks)) };
}
