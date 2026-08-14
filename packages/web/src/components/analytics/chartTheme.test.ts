import { describe, it, expect } from 'vitest';
import { SERIES, OTHER, makeSeriesScale, OUTCOME_COLOR } from './chartTheme';

describe('chart palette', () => {
  it('uses the five validated hues in fixed order', () => {
    expect(SERIES).toEqual(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']);
  });

  it('assigns deterministically regardless of the order the domain arrives in', () => {
    expect(makeSeriesScale(['opus', 'sonnet', 'haiku'])('opus')).toBe('#d95926');
    expect(makeSeriesScale(['haiku', 'sonnet', 'opus'])('opus')).toBe('#d95926');
  });

  // The hazard this API exists to prevent, stated as a test so it cannot be
  // forgotten: colour is assigned from the DOMAIN a scale was built with. Build
  // the scale once from every key in the dataset and reuse it while filtering what
  // you plot. Rebuilding it from the currently-visible subset repaints the
  // survivors — which is exactly the bug the old seriesColor(keys, key) shipped.
  it('assigns from the domain it was built with, so the scale must be built from ALL keys', () => {
    const fullDomain = makeSeriesScale(['opus', 'sonnet', 'haiku']);
    const wrongWay = makeSeriesScale(['opus', 'sonnet']); // haiku filtered out — do not do this

    expect(fullDomain('opus')).toBe('#d95926');
    expect(wrongWay('opus')).toBe('#3987e5');
    expect(fullDomain('opus')).not.toBe(wrongWay('opus'));
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
