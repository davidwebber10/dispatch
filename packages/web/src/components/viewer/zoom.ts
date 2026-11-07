/**
 * The zoom and pan math of the file viewer, kept pure so it is testable without a browser.
 *
 * The picture is drawn with `transform: translate(x, y) scale(scale)` from its centre, so a point
 * `c` of the picture (relative to its centre, at scale 1) lands at `c * scale + (x, y)` on the
 * stage. All points here are relative to the stage's centre, in CSS pixels.
 */
export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** A double tap or double click zooms to this. */
export const TAP_SCALE = 2.5;

export interface View { scale: number; x: number; y: number }
export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const FIT: View = { scale: 1, x: 0, y: 0 };

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/**
 * Keep the picture over the stage: at a scale where it overflows, its edge can reach the stage's edge
 * but never pass it; where it fits, it stays centred. A scale below 1 snaps back to the fit.
 */
export function clampView(v: View, picture: Size, stage: Size): View {
  const scale = clampScale(v.scale);
  const ox = Math.max(0, (picture.w * scale - stage.w) / 2);
  const oy = Math.max(0, (picture.h * scale - stage.h) / 2);
  return { scale, x: Math.min(ox, Math.max(-ox, v.x)), y: Math.min(oy, Math.max(-oy, v.y)) };
}

/**
 * Zoom to `scale` so that what sits under the point `at` stays under it (a pinch's midpoint, the
 * cursor under the wheel, the spot that was double-tapped). `shift` moves the view as well: a
 * pinch whose fingers drifted pans by the midpoint's travel.
 */
export function zoomAt(v: View, scale: number, at: Point, picture: Size, stage: Size, shift: Point = { x: 0, y: 0 }): View {
  const next = clampScale(scale);
  const k = next / v.scale;
  return clampView({ scale: next, x: at.x - (at.x - v.x) * k + shift.x, y: at.y - (at.y - v.y) * k + shift.y }, picture, stage);
}

/** A double tap toggles between the fit and TAP_SCALE around the tapped spot. */
export function toggleZoom(v: View, at: Point, picture: Size, stage: Size): View {
  return v.scale > 1.02 ? FIT : zoomAt(v, TAP_SCALE, at, picture, stage);
}

/** Pan by a finger's or the mouse's travel since the gesture began. */
export function panTo(start: View, travel: Point, picture: Size, stage: Size): View {
  return clampView({ ...start, x: start.x + travel.x, y: start.y + travel.y }, picture, stage);
}

/** True when the picture is (nearly) at the fit: a one-finger drag then swipes between files. */
export const atFit = (v: View): boolean => v.scale <= 1.02;

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** The swipe thresholds: a short fast flick or a long drag changes the file; a pull down closes. */
export const SWIPE_PX = 56;
export const SWIPE_FAST_PX_PER_MS = 0.45;
export const PULL_CLOSE_PX = 96;

/** What a one-finger drag at the fit meant when the finger lifted. */
export function swipeOutcome(travel: Point, ms: number): 'prev' | 'next' | 'close' | 'none' {
  const ax = Math.abs(travel.x);
  const fast = ms > 0 && ax / ms >= SWIPE_FAST_PX_PER_MS && ax >= 16;
  if (ax > Math.abs(travel.y) && (ax >= SWIPE_PX || fast)) return travel.x < 0 ? 'next' : 'prev';
  if (travel.y >= PULL_CLOSE_PX && travel.y > ax) return 'close';
  return 'none';
}
