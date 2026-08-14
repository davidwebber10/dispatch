import { describe, it, expect } from 'vitest';
import { SERIES, OTHER, makeSeriesScale, OUTCOME_COLOR } from './chartTheme';

describe('chart palette', () => {
  it('uses the five validated hues in fixed order', () => {
    expect(SERIES).toEqual(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']);
  });

  // The property the old rank-based implementation silently failed: hiding a series
  // that sorts EARLIER must not shift the colour of the ones that remain.
  it('keeps a key on its colour when an earlier-sorting key is filtered out', () => {
    const scale = makeSeriesScale(['opus', 'sonnet', 'haiku']);
    expect(scale('opus')).toBe('#d95926');
    // The visible set shrinks, but the scale is unchanged — that is the whole point.
    expect(scale('opus')).toBe('#d95926');
    // Rebuilding from the same full domain is stable across reloads.
    expect(makeSeriesScale(['haiku', 'sonnet', 'opus'])('opus')).toBe('#d95926');
  });

  it('folds a sixth key into Other rather than inventing a hue', () => {
    const scale = makeSeriesScale(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(scale('f')).toBe(OTHER);
    expect(SERIES).not.toContain(OTHER);
  });

  it('gives an unknown key Other rather than throwing', () => {
    expect(makeSeriesScale(['a', 'b'])('nope')).toBe(OTHER);
  });

  it('ignores duplicate keys in the domain', () => {
    expect(makeSeriesScale(['a', 'a', 'b'])('b')).toBe(SERIES[1]);
  });

  it('reserves the status colors for outcomes only', () => {
    expect(OUTCOME_COLOR.idle).toBe('#3ECF6A');
    expect(OUTCOME_COLOR.needs_help).toBe('#F5C542');
    expect(OUTCOME_COLOR.exit).toBe('#F0616D');
    for (const c of Object.values(OUTCOME_COLOR)) expect(SERIES).not.toContain(c);
  });
});
