import { describe, it, expect } from 'vitest';
import { SERIES, OTHER, seriesColor, OUTCOME_COLOR } from './chartTheme';

describe('chart palette', () => {
  it('uses the five validated hues in fixed order', () => {
    expect(SERIES).toEqual(['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']);
  });

  // Color follows the entity, not its rank: filtering a series out must not
  // repaint the ones that survive.
  it('gives a key the same color regardless of the other keys present', () => {
    const all = ['opus', 'sonnet', 'haiku'];
    expect(seriesColor(all, 'haiku')).toBe(seriesColor(['opus', 'haiku'], 'haiku'));
  });

  it('folds a sixth series into Other rather than inventing a hue', () => {
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(seriesColor(keys, 'f')).toBe(OTHER);
    expect(SERIES).not.toContain(OTHER);
  });

  it('reserves the status colors for outcomes only', () => {
    expect(OUTCOME_COLOR.idle).toBe('#3ECF6A');
    expect(OUTCOME_COLOR.needs_help).toBe('#F5C542');
    expect(OUTCOME_COLOR.exit).toBe('#F0616D');
    for (const c of Object.values(OUTCOME_COLOR)) expect(SERIES).not.toContain(c);
  });
});
