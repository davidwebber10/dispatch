/**
 * Small color math for the theme registry: parse a hex or rgb()/rgba() value, mix two colors,
 * and compute WCAG relative luminance and contrast. Pure functions, no DOM.
 */
export interface RGBA { r: number; g: number; b: number; a: number }

export function parseColor(input: string): RGBA {
  const s = input.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`Bad color: ${input}`);
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (fn) {
    const a = fn[4] == null ? 1 : fn[4].endsWith('%') ? parseFloat(fn[4]) / 100 : parseFloat(fn[4]);
    return { r: +fn[1], g: +fn[2], b: +fn[3], a };
  }
  throw new Error(`Bad color: ${input}`);
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();

export function toHex({ r, g, b }: RGBA): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `amount` of `b` mixed into `a` (0 gives a, 1 gives b), in sRGB, as an opaque hex. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseColor(a); const y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * amount, g: x.g + (y.g - x.g) * amount, b: x.b + (y.b - x.b) * amount, a: 1 });
}

/** A translucent color over an opaque background, as the opaque color the eye sees. */
export function over(fg: string, bg: string): string {
  const f = parseColor(fg);
  if (f.a >= 1) return toHex(f);
  return mix(bg, toHex(f), f.a);
}

export function luminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a); const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Of the candidates, the one with the most contrast against `bg`. */
export function bestOn(bg: string, ...candidates: string[]): string {
  return candidates.reduce((best, c) => (contrast(c, bg) > contrast(best, bg) ? c : best));
}
