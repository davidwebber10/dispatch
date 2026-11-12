import { api } from '../api/client';
import { isBusinessPreview, usesOsLook } from './hostContext';

/**
 * Accent-tinted app icons. The bundled PWA icons are green; this re-renders
 * the same design (accent field, dark `>_` glyph) on a canvas in the current
 * accent color, swaps the favicon live, and uploads the set to the daemon,
 * which serves them at the icon URLs. "Add to Home Screen" then installs the
 * tinted icon — iOS snapshots icons at install, so an already-installed app
 * only changes after removing and re-adding it.
 */

/** Mix a hex color toward white (amt > 0) or black (amt < 0). */
function shade(hex: string, amt: number): string {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const target = amt > 0 ? 255 : 0;
  const t = Math.abs(amt);
  const ch = (i: number) => Math.round(parseInt(n.slice(i, i + 2), 16) * (1 - t) + target * t);
  // literal color: a canvas color string computed from the accent hex for the PNG app icon
  return `rgb(${ch(0)},${ch(2)},${ch(4)})`;
}

/**
 * Draw the icon at `size` px; null when canvas isn't available (jsdom). The glyph is the `>_` of the
 * developer tool, or, on a hosted workspace (Dispatch inside Polywood OS), a neutral compass.
 */
export function drawAppIcon(size: number, accent: string, glyph: 'terminal' | 'compass' = usesOsLook() ? 'compass' : 'terminal'): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const s = size / 180; // design space matches the shipped 180px apple-touch-icon

  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, shade(accent, 0.10));
  g.addColorStop(1, shade(accent, -0.10));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // literal color: the dark `>_` glyph is content of the PWA icon PNG, the same in every theme
  ctx.strokeStyle = '#0A1410';
  ctx.lineWidth = 15.5 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (glyph === 'compass') {
    ctx.lineWidth = 11 * s;
    ctx.beginPath(); // the ring
    ctx.arc(90 * s, 90 * s, 50 * s, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; // the same dark ink as the ring
    ctx.beginPath(); // the needle: a diamond pointing up-right
    ctx.moveTo(118 * s, 62 * s);
    ctx.lineTo(98 * s, 98 * s);
    ctx.lineTo(62 * s, 118 * s);
    ctx.lineTo(82 * s, 82 * s);
    ctx.closePath();
    ctx.fill();
    return canvas;
  }
  ctx.beginPath(); // chevron >
  ctx.moveTo(47 * s, 60 * s);
  ctx.lineTo(90 * s, 89.5 * s);
  ctx.lineTo(47 * s, 119 * s);
  ctx.stroke();
  ctx.beginPath(); // underscore _
  ctx.moveTo(99 * s, 119 * s);
  ctx.lineTo(131 * s, 119 * s);
  ctx.stroke();
  return canvas;
}

const ICON_SIZES: Array<[name: string, px: number]> = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['favicon-32.png', 32],
];

/** Re-render all icons in `accent`, swap the favicon live, upload to the daemon. */
export async function syncAppIcons(accent: string): Promise<void> {
  try {
    const icons: Record<string, string> = {};
    for (const [name, px] of ICON_SIZES) {
      const canvas = drawAppIcon(px, accent);
      if (!canvas) return; // no canvas (tests) — nothing to sync
      icons[name] = canvas.toDataURL('image/png').split(',')[1];
    }
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (link) link.href = `data:image/png;base64,${icons['favicon-32.png']}`;
    // The business preview is this browser only: the icons the daemon serves (home-screen installs) stay.
    if (isBusinessPreview()) return;
    await api.putAppearanceIcons(icons);
  } catch { /* older daemon / offline — purely cosmetic, ignore */ }
}

/** A hosted workspace (or the business preview): swap the bundled `>_` favicon for the compass at launch. */
export function applyHostedFavicon(accent: string): void {
  if (!usesOsLook()) return;
  try {
    const canvas = drawAppIcon(32, accent, 'compass');
    const link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (canvas && link) link.href = canvas.toDataURL('image/png');
  } catch { /* no canvas: keep the bundled icon */ }
}
