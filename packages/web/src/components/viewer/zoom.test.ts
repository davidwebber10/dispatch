import { describe, it, expect } from 'vitest';
import { FIT, TAP_SCALE, clampView, panTo, swipeOutcome, toggleZoom, zoomAt } from './zoom';

const picture = { w: 300, h: 200 };
const stage = { w: 400, h: 300 };

describe('zoom math (2026-11-07)', () => {
  it('clamps the scale to [1, 6] and keeps a fitted picture centred', () => {
    expect(clampView({ scale: 0.4, x: 50, y: 50 }, picture, stage)).toEqual({ scale: 1, x: 0, y: 0 });
    expect(clampView({ scale: 9, x: 0, y: 0 }, picture, stage).scale).toBe(6);
  });

  it('lets an overflowing picture reach the stage edge, never past it', () => {
    // At 2x the picture is 600x400 over a 400x300 stage: 100px of play each way in x, 50 in y.
    expect(clampView({ scale: 2, x: 500, y: -500 }, picture, stage)).toEqual({ scale: 2, x: 100, y: -50 });
  });

  it('zoomAt keeps the spot under the fingers under the fingers', () => {
    // The point 50px right of centre at the fit shows picture point c = 50. At 2x it must still be at 50.
    const v = zoomAt(FIT, 2, { x: 50, y: 0 }, picture, stage);
    expect(v.scale).toBe(2);
    expect(50 * 2 + v.x).toBe(50);
  });

  it('a pinch whose midpoint drifted pans by the drift', () => {
    const v = zoomAt(FIT, 2, { x: 0, y: 0 }, picture, stage, { x: -30, y: 0 });
    expect(v.x).toBe(-30);
  });

  it('a double tap zooms to TAP_SCALE around the spot, and back to the fit', () => {
    const z = toggleZoom(FIT, { x: 100, y: 0 }, picture, stage);
    expect(z.scale).toBe(TAP_SCALE);
    expect(toggleZoom(z, { x: 0, y: 0 }, picture, stage)).toEqual(FIT);
  });

  it('panTo moves from the gesture start and stays inside the edges', () => {
    const start = { scale: 2, x: 0, y: 0 };
    expect(panTo(start, { x: 40, y: 10 }, picture, stage)).toEqual({ scale: 2, x: 40, y: 10 });
    expect(panTo(start, { x: 400, y: 400 }, picture, stage)).toEqual({ scale: 2, x: 100, y: 50 });
  });

  it('swipeOutcome: a long drag or a fast flick changes the file; a pull down closes; a short drag does nothing', () => {
    expect(swipeOutcome({ x: -80, y: 5 }, 400)).toBe('next');
    expect(swipeOutcome({ x: 80, y: 5 }, 400)).toBe('prev');
    expect(swipeOutcome({ x: -30, y: 0 }, 40)).toBe('next');
    expect(swipeOutcome({ x: -30, y: 0 }, 400)).toBe('none');
    expect(swipeOutcome({ x: 10, y: 120 }, 300)).toBe('close');
    expect(swipeOutcome({ x: 10, y: -120 }, 300)).toBe('none');
  });
});
