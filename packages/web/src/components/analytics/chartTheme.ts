/**
 * The analytics palette.
 *
 * Dispatch's theme offers only three chart-usable colors, and all three are STATUS
 * colors (accent green, warning yellow, error red). Reusing one as "series 4" would
 * make a model look like a failure, so the categorical hues below are the view's
 * own. They were validated against the Dispatch pane surface #141416 in dark mode:
 * lightness band, chroma floor, colorblind separation (worst adjacent pair ΔE 8.4
 * protan), normal-vision floor (worst 19.3) and contrast all pass.
 *
 * Hues are assigned by sorted key, never by the order a filter happens to return —
 * so hiding one model does not repaint the others. A sixth series folds into
 * OTHER rather than generating a new hue.
 */
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'] as const;
export const OTHER = '#6b6b73';

export function seriesColor(keys: string[], key: string): string {
  const i = [...keys].sort().indexOf(key);
  if (i < 0) return OTHER;
  return i < SERIES.length ? SERIES[i] : OTHER;
}

/** Outcomes are states, not identities, so they wear the reserved status colors. */
export const OUTCOME_COLOR: Record<string, string> = {
  idle: '#3ECF6A',
  needs_help: '#F5C542',
  scheduled: '#8E8E96',
  exit: '#F0616D',
  interrupted: '#5A5A61',
};

/**
 * Recharts needs literal colors — it cannot take `var(--color-text-tertiary)`.
 * Read the computed custom properties once, so theme.css stays the single source
 * of truth for everything except the categorical hues above.
 */
export function resolveChartTheme(): { text: string; muted: string; grid: string; surface: string } {
  const fallback = { text: '#E9E9EC', muted: '#8E8E96', grid: '#29292E', surface: '#141416' };
  if (typeof window === 'undefined' || !window.getComputedStyle) return fallback;
  const s = getComputedStyle(document.documentElement);
  const read = (name: string, dflt: string) => s.getPropertyValue(name).trim() || dflt;
  return {
    text: read('--color-text-primary', fallback.text),
    muted: read('--color-text-secondary', fallback.muted),
    grid: read('--color-border', fallback.grid),
    surface: read('--color-pane', fallback.surface),
  };
}
