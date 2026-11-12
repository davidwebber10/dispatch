// Font sizes for the text-scale slider. Each size is a CSS variable `--fs-<n>` in theme.css
// (dot replaced by dash, e.g. 12.5 -> --fs-12-5), defined as px / 16 rem. <html> is 16px at 100%,
// so each size is its old pixel size at 100% and follows the scale otherwise. This list is every
// pixel font size the web app uses; fontSize.test.ts keeps it in step with theme.css.
export const FONT_SIZES: readonly number[] = [
  7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16,
  17, 18, 19, 20, 21, 22, 24, 28, 40,
];

const KNOWN = new Set(FONT_SIZES);

// Returns the CSS value for a pixel font size: the scale variable when the size is on the scale,
// otherwise the same size in rem.
export function fontVar(px: number): string {
  return KNOWN.has(px) ? `var(--fs-${String(px).replace('.', '-')})` : `${px / 16}rem`;
}

// Font size for inputs. iOS zooms the page when a focused input is under 16px, so this never goes below 16px.
export function fontVarInput(px: number): string {
  return `max(16px, ${fontVar(px)})`;
}
