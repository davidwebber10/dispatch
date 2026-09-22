import { TerminalWindow } from '@phosphor-icons/react';

const ACCENT = 'var(--color-accent)';
/** Hairline for the control border. */
const BORDER = '#2C2C32';
/** The selected tint for a harness tile, plus its inset ring. */
const ON_BG = 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))';
const ON_RING = 'inset 0 0 0 1px rgba(62,207,106,.5)';

function ClaudeMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 512 512" fill="#D97757" style={{ display: 'block' }}>
      <path d="M100.4 340.5l100.7-56.5 1.7-4.9-1.7-2.7-4.9 0-16.8-1-57.5-1.6-49.9-2.1-48.3-2.6-12.2-2.6-11.4-15 1.2-7.5 10.2-6.9 14.7 1.3c18.9 1.3 45.9 3.1 81 5.6l35.2 2.1 52.2 5.4 8.3 0 1.2-3.4-2.8-2.1-2.2-2.1-50.3-34.1-54.4-36-28.5-20.7-15.4-10.5-7.8-9.8-3.4-21.5 14-15.4 18.8 1.3 4.8 1.3 19 14.7 40.7 31.5 53.1 39.1 7.8 6.5 3.1-2.2 .4-1.6-3.5-5.8-28.9-52.2-30.8-53.1-13.7-22-3.6-13.2c-1.3-5.4-2.2-10-2.2-15.5l15.9-21.6 8.8-2.8 21.2 2.8 8.9 7.8 13.2 30.2 21.4 47.5 33.2 64.6 9.7 19.2 5.2 17.8 1.9 5.4 3.4 0 0-3.1 2.7-36.4 5-44.7 4.9-57.5 1.7-16.2 8-19.4 15.9-10.5 12.4 5.9 10.2 14.7-1.4 9.5-6.1 39.5-11.9 61.9-7.8 41.5 4.5 0 5.2-5.2 21-27.8 35.2-44.1 15.5-17.5 18.1-19.3 11.6-9.2 22 0 16.2 24.1-7.3 24.9-22.7 28.7-18.8 24.4-27 36.3-16.8 29 1.6 2.3 4-.4 60.9-13 32.9-5.9 39.3-6.7 17.8 8.3 1.9 8.4-7 17.2-42 10.4-49.2 9.8-73.3 17.3-.9 .7 1 1.3 33 3.1 14.1 .8 34.6 0 64.4 4.8 16.8 11.1 10.1 13.6-1.7 10.4-25.9 13.2c-15.5-3.7-54.4-12.9-116.6-27.7l-28-7-3.9 0 0 2.3 23.3 22.8 42.7 38.6 53.5 49.8 2.7 12.3-6.9 9.7-7.3-1-47-35.4-18.1-15.9-41.1-34.6-2.7 0 0 3.6 9.5 13.9 50 75.2 2.6 23-3.6 7.5-13 4.5-14.2-2.6-29.3-41.1-30.2-46.3-24.4-41.5-3 1.7-14.4 154.8-6.7 7.9-15.5 5.9-13-9.8-6.9-15.9 6.9-31.5 8.3-41.1 6.7-32.7 6.1-40.6 3.6-13.5-.2-.9-3 .4-30.6 42-46.5 62.9-36.8 39.4-8.8 3.5-15.3-7.9 1.4-14.1 8.5-12.6 50.9-64.8 30.7-40.2 19.8-23.2-.1-3.4-1.2 0-135.3 87.8-24.1 3.1-10.4-9.7 1.3-15.9 4.9-5.2 40.7-28-.1 .1 0 .1z" />
    </svg>
  );
}

function OpenAIMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 512 512" fill="#ECECEC" style={{ display: 'block' }}>
      <path d="M196.4 185.8l0-48.6c0-4.1 1.5-7.2 5.1-9.2l97.8-56.3c13.3-7.7 29.2-11.3 45.6-11.3 61.4 0 100.4 47.6 100.4 98.3 0 3.6 0 7.7-.5 11.8L343.3 111.1c-6.1-3.6-12.3-3.6-18.4 0L196.4 185.8zM424.7 375.2l0-116.2c0-7.2-3.1-12.3-9.2-15.9L287 168.4 329 144.3c3.6-2 6.7-2 10.2 0L437 200.7c28.2 16.4 47.1 51.2 47.1 85 0 38.9-23 74.8-59.4 89.6l0 0zM166.2 272.8l-42-24.6c-3.6-2-5.1-5.1-5.1-9.2l0-112.6c0-54.8 42-96.3 98.8-96.3 21.5 0 41.5 7.2 58.4 20L175.4 108.5c-6.1 3.6-9.2 8.7-9.2 15.9l0 148.5 0 0zm90.4 52.2l-60.2-33.8 0-71.7 60.2-33.8 60.2 33.8 0 71.7-60.2 33.8zm38.7 155.7c-21.5 0-41.5-7.2-58.4-20l100.9-58.4c6.1-3.6 9.2-8.7 9.2-15.9l0-148.5 42.5 24.6c3.6 2 5.1 5.1 5.1 9.2l0 112.6c0 54.8-42.5 96.3-99.3 96.3l0 0zM173.8 366.5L76.1 310.2c-28.2-16.4-47.1-51.2-47.1-85 0-39.4 23.6-74.8 59.9-89.6l0 116.7c0 7.2 3.1 12.3 9.2 15.9l128 74.2-42 24.1c-3.6 2-6.7 2-10.2 0zm-5.6 84c-57.9 0-100.4-43.5-100.4-97.3 0-4.1 .5-8.2 1-12.3l100.9 58.4c6.1 3.6 12.3 3.6 18.4 0l128.5-74.2 0 48.6c0 4.1-1.5 7.2-5.1 9.2l-97.8 56.3c-13.3 7.7-29.2 11.3-45.6 11.3l0 0zm127 60.9c62 0 113.7-44 125.4-102.4 57.3-14.9 94.2-68.6 94.2-123.4 0-35.8-15.4-70.7-43-95.7 2.6-10.8 4.1-21.5 4.1-32.3 0-73.2-59.4-128-128-128-13.8 0-27.1 2-40.4 6.7-23-22.5-54.8-36.9-89.6-36.9-62 0-113.7 44-125.4 102.4-57.3 14.8-94.2 68.6-94.2 123.4 0 35.8 15.4 70.7 43 95.7-2.6 10.8-4.1 21.5-4.1 32.3 0 73.2 59.4 128 128 128 13.8 0 27.1-2 40.4-6.7 23 22.5 54.8 36.9 89.6 36.9z" />
    </svg>
  );
}

/** xAI's mark — the angular slash monogram. */
function GrokMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="#E9E9EC" style={{ display: 'block' }}>
      <path d="M4.2 19.8L14.6 4.2h3.5L7.7 19.8H4.2zm11.1 0l-3.4-5.1 2-3 5.4 8.1h-4z" />
    </svg>
  );
}

/** OpenCode's mark — the square-bracket code glyph, matching its terminal-brand look. */
function OpenCodeMark({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#E9E9EC" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M8 4H5v16h3" />
      <path d="M16 4h3v16h-3" />
      <path d="M10.5 15l3-6" />
    </svg>
  );
}

/** The plain shell has no brand, so it uses the house icon set like every other glyph. */
function TerminalMark({ size }: { size: number }) {
  return <TerminalWindow size={size} weight="regular" color="var(--color-text-secondary)" style={{ display: 'block' }} />;
}

export const HARNESS_MARK: Record<string, (p: { size: number }) => JSX.Element> = {
  claude: ClaudeMark,
  codex: OpenAIMark,
  grok: GrokMark,
  opencode: OpenCodeMark,
  terminal: TerminalMark,
};

/**
 * The harness (agent/shell) picker strip: desktop renders one segmented row, every
 * harness a column; phone renders a row of pills that scrolls sideways, bleeding to
 * the sheet edge. A harness whose CLI is missing is dimmed and tagged "Install", but
 * stays SELECTABLE: picking it is how the caller reaches its install prompt.
 */
export function HarnessStrip({ harnesses, value, onSelect, isAvailable, mobile, markSize }: {
  harnesses: { id: string; label: string }[];
  value: string;
  onSelect: (id: string) => void;
  /** Whether a harness's CLI is present on the box. Default: always available. */
  isAvailable?: (id: string) => boolean;
  /** Phone pill row (bleed) vs desktop segmented grid. */
  mobile: boolean;
  markSize?: { mobile: number; desktop: number };
}) {
  const available = isAvailable ?? (() => true);
  const size = markSize ?? { mobile: 16, desktop: 18 };

  if (mobile) {
    return (
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', margin: '0 -16px', padding: '0 16px', scrollbarWidth: 'none' }}>
        {harnesses.map((h) => {
          const on = value === h.id;
          const canRun = available(h.id);
          const Mark = HARNESS_MARK[h.id] ?? TerminalMark;
          return (
            <button key={h.id} type="button" aria-pressed={on}
              title={canRun ? undefined : `${h.label} is not installed — select to install it`}
              onClick={() => onSelect(h.id)}
              style={{
                flex: 'none', display: 'flex', alignItems: 'center', gap: 7, height: 40, padding: '0 12px 0 10px',
                borderRadius: 20, cursor: 'pointer', font: '600 12.5px var(--font-sans)',
                background: on ? ON_BG : 'var(--color-elevated)',
                border: `1px solid ${on ? 'rgba(62,207,106,.5)' : BORDER}`,
                color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                opacity: canRun || on ? 1 : 0.45,
                transition: 'background .15s, border-color .15s, opacity .15s',
              }}>
              <span style={{ display: 'flex', opacity: on ? 1 : 0.7 }}><Mark size={size.mobile} /></span>
              <div style={{ whiteSpace: 'nowrap' }}>{h.label}</div>
              {!canRun && <div style={{ font: '600 9.5px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: ACCENT }}>Install</div>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, minmax(0, 1fr))`, background: 'var(--color-elevated)', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 3, gap: 3 }}>
      {harnesses.map((h) => {
        const on = value === h.id;
        const canRun = available(h.id);
        const Mark = HARNESS_MARK[h.id] ?? TerminalMark;
        return (
          <button key={h.id} type="button" aria-pressed={on}
            title={canRun ? undefined : `${h.label} is not installed — select to install it`}
            onClick={() => onSelect(h.id)}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 4px 9px',
              borderRadius: 7, border: 'none', cursor: 'pointer', font: '600 11px var(--font-sans)',
              background: on ? ON_BG : 'transparent',
              color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              boxShadow: on ? ON_RING : 'none',
              // Dimmed while unavailable, but full strength once selected, so the
              // selection never looks half-applied.
              opacity: canRun || on ? 1 : 0.45,
              transition: 'background .15s, color .15s, opacity .15s',
            }}>
            <span style={{ display: 'flex', opacity: on ? 1 : 0.7 }}><Mark size={size.desktop} /></span>
            <div style={{ whiteSpace: 'nowrap' }}>{h.label}</div>
            {!canRun && <div style={{ font: '600 9px var(--font-mono)', letterSpacing: '.06em', textTransform: 'uppercase', color: ACCENT }}>Install</div>}
          </button>
        );
      })}
    </div>
  );
}
