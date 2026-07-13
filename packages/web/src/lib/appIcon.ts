import { api } from '../api/client';

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
  return `rgb(${ch(0)},${ch(2)},${ch(4)})`;
}

/** Draw the icon at `size` px; null when canvas isn't available (jsdom). */
export function drawAppIcon(size: number, accent: string): HTMLCanvasElement | null {
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

  ctx.strokeStyle = '#0A1410';
  ctx.lineWidth = 15.5 * s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
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
    await api.putAppearanceIcons(icons);
  } catch { /* older daemon / offline — purely cosmetic, ignore */ }
}
