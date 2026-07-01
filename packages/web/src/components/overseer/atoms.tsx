// Overseer view — shared atoms (spec §3 "Shared atoms" / §8 icon table).
//
// Components consume these directly. The <Icon> map covers every ph-* class used in
// the design so the rest of the module can keep referencing phosphor by class name
// (matching the source design's data fields like AGENT_TYPE.icon === 'ph-code').

import type { CSSProperties, ReactNode } from 'react';
import {
  Archive,
  ArrowBendDownRight,
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  ArrowsLeftRight,
  ArrowsMerge,
  ArrowUpRight,
  BatteryHigh,
  Broadcast,
  CellSignalFull,
  ChatTeardropText,
  Check,
  CheckCircle,
  Circle,
  CircleNotch,
  Code,
  Compass,
  DeviceMobile,
  FolderSimple,
  Gear,
  HandPalm,
  type Icon as PhosphorIcon,
  Lightning,
  MagnifyingGlass,
  Monitor,
  Moon,
  Notebook,
  PaperPlaneRight,
  PencilSimple,
  Plus,
  SealCheck,
  ShieldCheck,
  Stack,
  SteeringWheel,
  Stop,
  TerminalWindow,
  User,
  Warning,
  WifiHigh,
  X,
} from '@phosphor-icons/react';

// ph-* class → @phosphor-icons/react component (spec §8 — every class covered).
const ICONS: Record<string, PhosphorIcon> = {
  'ph-broadcast': Broadcast,
  'ph-folder-simple': FolderSimple,
  'ph-warning': Warning,
  'ph-check-circle': CheckCircle,
  'ph-gear': Gear,
  'ph-monitor': Monitor,
  'ph-device-mobile': DeviceMobile,
  'ph-notebook': Notebook,
  'ph-plus': Plus,
  'ph-paper-plane-right': PaperPlaneRight,
  'ph-arrow-bend-down-right': ArrowBendDownRight,
  'ph-arrow-clockwise': ArrowClockwise,
  'ph-arrows-left-right': ArrowsLeftRight,
  'ph-arrows-merge': ArrowsMerge,
  'ph-shield-check': ShieldCheck,
  'ph-chat-teardrop-text': ChatTeardropText,
  'ph-terminal-window': TerminalWindow,
  'ph-seal-check': SealCheck,
  'ph-user': User,
  'ph-compass': Compass,
  'ph-code': Code,
  'ph-magnifying-glass': MagnifyingGlass,
  'ph-stack': Stack,
  'ph-arrow-up-right': ArrowUpRight,
  'ph-arrow-left': ArrowLeft,
  'ph-steering-wheel': SteeringWheel,
  'ph-pencil-simple': PencilSimple,
  'ph-hand-palm': HandPalm,
  'ph-stop': Stop,
  'ph-archive': Archive,
  'ph-lightning': Lightning,
  'ph-check': Check,
  'ph-circle-notch': CircleNotch,
  'ph-circle': Circle,
  'ph-x': X,
  'ph-arrow-right': ArrowRight,
  'ph-moon': Moon,
  'ph-cell-signal-full': CellSignalFull,
  'ph-wifi-high': WifiHigh,
  'ph-battery-high': BatteryHigh,
};

export type IconWeight = 'regular' | 'bold' | 'fill';

export function Icon({
  name,
  weight = 'regular',
  size = 16,
  color,
  style,
}: {
  name: string;
  weight?: IconWeight;
  size?: number;
  color?: string;
  style?: CSSProperties;
}) {
  const Cmp = ICONS[name];
  if (!Cmp) {
    if (typeof console !== 'undefined') console.warn(`[overseer] unknown icon "${name}"`);
    return null;
  }
  return <Cmp weight={weight} size={size} color={color} style={style} />;
}

// 6px living status dot (spec §3). `anim` is a full CSS animation shorthand string,
// e.g. "breathe var(--pulse) ease-in-out infinite".
export function StatusDot({
  color,
  anim = 'none',
  size = 6,
}: {
  color: string;
  anim?: string;
  size?: number;
}) {
  return (
    <span
      style={{
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        animation: anim,
        display: 'inline-block',
      }}
    />
  );
}

// Rounded square holding an agent-type phosphor icon (spec §6 — 28×28 default).
export function TypeIconBox({ icon, size = 28 }: { icon: string; size?: number }) {
  return (
    <div
      style={{
        flex: 'none',
        width: size,
        height: size,
        borderRadius: 7,
        background: 'var(--pane)',
        border: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--ts)',
      }}
    >
      <Icon name={icon} size={Math.round(size * 0.54)} />
    </div>
  );
}

// 3px progress track + accent fill (spec §6 — thread chip / working only).
export function ProgressBar({ width }: { width: string }) {
  return (
    <div style={{ flex: 1, height: 3, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width, background: 'var(--acc)', borderRadius: 3 }} />
    </div>
  );
}

// Uppercase mono tracking label (spec §6 — "Ongoing work", "Activity", "Needs you").
export function MonoLabel({
  children,
  color = 'var(--tt)',
  size = 10.5,
  spacing = '.09em',
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  spacing?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: size,
        letterSpacing: spacing,
        textTransform: 'uppercase',
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// The btn()-styled pill button (spec §6 — need-card actions). Pass bg/fg/bd from a
// NeedAction (or any of the matching shapes).
export function PillButton({
  bg,
  fg,
  bd,
  onClick,
  children,
  title,
  style,
}: {
  bg: string;
  fg: string;
  bd: string;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '7px 13px',
        borderRadius: 8,
        background: bg,
        color: fg,
        border: bd,
        fontFamily: 'inherit',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// Root wrapper style: declares the token vars inline (value-exact to the source
// design, which set them on the root) plus the base bg/color/font. tokens.css also
// declares the vars via :where(.overseer-root) as a low-specificity fallback.
export const overseerRootStyle: CSSProperties = {
  // tokens
  '--canvas': '#08080A',
  '--base': '#0F0F11',
  '--pane': '#141416',
  '--elev': '#1B1B1E',
  '--hover': '#26262B',
  '--border': '#29292E',
  '--acc': '#3ECF6A',
  '--accDim': 'rgba(62,207,106,.12)',
  '--accLine': 'rgba(62,207,106,.4)',
  '--yellow': '#F5C542',
  '--yellowDim': 'rgba(245,197,66,.1)',
  '--yellowLine': 'rgba(245,197,66,.35)',
  '--red': '#F0616D',
  '--tp': '#E9E9EC',
  '--ts': '#8E8E96',
  '--tt': '#5A5A61',
  '--mono': "'JetBrains Mono', monospace",
  '--pulse': '2.4s',
  // base
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--canvas)',
  color: 'var(--tp)',
  fontFamily: "'IBM Plex Sans', sans-serif",
  fontSize: 13,
} as CSSProperties;
