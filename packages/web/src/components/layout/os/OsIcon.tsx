import type { CSSProperties } from 'react';

/**
 * The OS shell's glyphs, as inline SVG (1.5px strokes on a 24 grid, in the manner of Phosphor
 * "regular"). Inline on purpose: Phosphor icon modules are shared code, and the build would move any
 * icon this lazy chunk imports into the first-load chunk that a local install also pays for.
 *
 * `osIcon(name)` maps the Phosphor name that GET /api/dispatch/shell sends; a name not listed gets
 * the generic app glyph. Add a name here when OS starts sending a new one.
 */
export type Glyph = (p: { size?: number; style?: CSSProperties; className?: string; color?: string }) => JSX.Element;

function make(paths: string[], fill = false): Glyph {
  const G: Glyph = ({ size = 18, style, className, color }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color ?? 'currentColor'} strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style} className={className}>
      {paths.map((d, i) => <path key={i} d={d} fill={fill && i === paths.length - 1 ? (color ?? 'currentColor') : 'none'} />)}
    </svg>
  );
  return G;
}

export const AppGlyph = make(['M4 5h16v14H4z', 'M4 9h16']);
export const RobotGlyph = make(['M5 8h14v11H5z', 'M12 4v4', 'M9 13h.01', 'M15 13h.01', 'M9.5 16.5h5']);
export const CaretDownGlyph = make(['M6 9l6 6 6-6']);
export const ListGlyph = make(['M4 6h16', 'M4 12h16', 'M4 18h16']);
export const GearGlyph = make(['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.6a7 7 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z']);
export const SidebarGlyph = make(['M4 5h16v14H4z', 'M9 5v14']);
export const SunGlyph = make(['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4']);
export const MoonGlyph = make(['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z']);
export const UserGlyph = make(['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5']);

const ICONS: Record<string, Glyph> = {
  AppWindow: AppGlyph,
  Robot: RobotGlyph,
  Gear: GearGlyph,
  House: make(['M4 11l8-7 8 7', 'M6 9.5V20h12V9.5']),
  Compass: make(['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M15.5 8.5l-2 5-5 2 2-5z']),
  Sparkle: make(['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z', 'M19 16v4', 'M17 18h4']),
  ChartBar: make(['M4 20h16', 'M7 20v-7', 'M12 20V6', 'M17 20v-10']),
  ChartLine: make(['M4 20h16', 'M4 16l5-5 4 3 7-8']),
  ShoppingCart: make(['M3 4h2l2.5 11h11L21 7H6.2', 'M9 20h.01', 'M17 20h.01']),
  SquaresFour: make(['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z']),
  Package: make(['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9']),
  Users: make(['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M2.5 20c1-3.3 3.5-5 6.5-5s5.5 1.7 6.5 5', 'M16 4.5a3.5 3.5 0 0 1 0 6.5', 'M18 15c1.8.7 3 2.4 3.5 5']),
  FileText: make(['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6']),
  Table: make(['M4 5h16v14H4z', 'M4 10h16', 'M4 15h16', 'M10 10v9']),
  Truck: make(['M3 6h11v10H3z', 'M14 10h4l3 3v3h-7', 'M7 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M17 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z']),
  ChatCircleDots: make(['M12 4a8 8 0 0 0-6.9 12L4 20l4-1.1A8 8 0 1 0 12 4z', 'M8.5 12h.01', 'M12 12h.01', 'M15.5 12h.01']),
};

export function osIcon(name: string | undefined): Glyph {
  return (name && ICONS[name]) || AppGlyph;
}

/** Dispatch's own icon in the switcher (the current app). */
export const PRODUCT_ICON: Glyph = RobotGlyph;
