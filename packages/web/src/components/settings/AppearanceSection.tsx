import { useState } from 'react';
import { Check, Palette } from '@phosphor-icons/react';
import { useSettings, ACCENTS, formatSidebarLimit, stepSidebarLimit, type DocEditor, type Density } from '../../stores/settings';
import { THEMES, SYSTEM_DARK, SYSTEM_LIGHT, getTheme, resolveTokens, onAccent, type Theme } from '../../themes';
import { useActiveTheme } from '../../themes/apply';
import { SettingsPage, SettingsGroup, SettingsRow, Toggle, Stepper, Sheet, Slider } from './ui';
import { Select } from '../common/Select';
import { Segmented } from '../common/Segmented';
import { fontVar } from '../../lib/fontSize';

const DOC_EDITORS = [{ value: '', label: 'None' }, { value: 'vscode', label: 'VS Code' }, { value: 'cursor', label: 'Cursor' }, { value: 'zed', label: 'Zed' }];
const DENSITIES: { value: Density; label: string }[] = [{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Cozy' }, { value: 'roomy', label: 'Roomy' }];

const tileGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 8 };
const subLabel: React.CSSProperties = { font: `500 ${fontVar(10)} var(--font-mono)`, letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--color-text-tertiary)', margin: '4px 0 -2px' };

/** A theme in miniature: its canvas, a pane, two lines of text and the accent. Colors are the theme's own values. */
function Swatch({ theme, height = 44 }: { theme: Theme; height?: number }) {
  const tk = resolveTokens(theme);
  const inset = height < 30 ? 3 : 6;
  return (
    <span data-testid="theme-swatch" aria-hidden="true" style={{ position: 'relative', display: 'block', height, borderRadius: 'var(--radius-sm)', background: tk.canvas, border: `1px solid ${tk.border}`, overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: inset, top: inset, right: inset, bottom: inset, borderRadius: 'var(--radius-xs)', background: tk.pane, border: `1px solid ${tk.border}` }}>
        <span style={{ position: 'absolute', left: inset, top: inset, width: '55%', height: height < 30 ? 2 : 4, borderRadius: 'var(--radius-xs)', background: tk['text-primary'] }} />
        <span style={{ position: 'absolute', left: inset, top: height < 30 ? inset + 4 : 14, width: '38%', height: height < 30 ? 2 : 4, borderRadius: 'var(--radius-xs)', background: tk['text-secondary'] }} />
        <span style={{ position: 'absolute', right: inset, bottom: height < 30 ? 2 : 5, width: height < 30 ? 7 : 16, height: height < 30 ? 4 : 8, borderRadius: 'var(--radius-xs)', background: tk.accent }} />
      </span>
    </span>
  );
}

/** The "System" preview: half Dispatch Light, half Dispatch Dark (the device's setting picks). */
function SystemSwatch({ height = 44 }: { height?: number }) {
  return (
    <span style={{ position: 'relative', display: 'block', height }}>
      <span style={{ position: 'absolute', inset: 0, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}><Swatch theme={SYSTEM_LIGHT} height={height} /></span>
      <span style={{ position: 'absolute', inset: 0, clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}><Swatch theme={SYSTEM_DARK} height={height} /></span>
    </span>
  );
}

function ThemeTile({ label, on, onPick, children }: { label: string; on: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label} onClick={onPick}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6, minWidth: 0, background: on ? 'var(--color-hover)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left' }}>
      {children}
      <span style={{ fontSize: fontVar(12), fontWeight: on ? 600 : 400, color: on ? 'var(--color-text-primary)' : 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

/** The theme picker (in the Theme sheet): System first, then the light themes, then the dark ones. Picking one applies it at once. */
function ThemePicker() {
  const setting = useSettings((s) => s.theme);
  const pick = (id: string) => useSettings.getState().setTheme(id);
  const light = THEMES.filter((t) => t.kind === 'light');
  const dark = THEMES.filter((t) => t.kind === 'dark');
  return (
    <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={tileGrid}>
        <ThemeTile label="System" on={setting === 'system'} onPick={() => pick('system')}><SystemSwatch /></ThemeTile>
      </div>
      <span style={subLabel}>Light</span>
      <div style={tileGrid}>
        {light.map((t) => <ThemeTile key={t.id} label={t.name} on={setting === t.id} onPick={() => pick(t.id)}><Swatch theme={t} /></ThemeTile>)}
      </div>
      <span style={subLabel}>Dark</span>
      <div style={tileGrid}>
        {dark.map((t) => <ThemeTile key={t.id} label={t.name} on={setting === t.id} onPick={() => pick(t.id)}><Swatch theme={t} /></ThemeTile>)}
      </div>
    </div>
  );
}

/** One round accent swatch; the picked one carries a check in a color that reads on it. */
const dot = (bg: string, on: boolean): React.CSSProperties => ({
  position: 'relative', width: 28, height: 28, padding: 0, borderRadius: '50%', background: bg, border: 'none', cursor: 'pointer', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  boxShadow: on ? '0 0 0 2px var(--color-pane), 0 0 0 4px var(--color-text-secondary)' : 'inset 0 0 0 1px var(--color-border-strong)',
});

/** The accent swatches: the theme's own accent first, then the presets, then any color. */
function AccentPicker() {
  const accent = useSettings((s) => s.accent);
  const shownAccent = useActiveTheme((s) => s.accent);
  const theme = useActiveTheme((s) => s.theme);
  const themeAccent = resolveTokens(theme).accent;
  const set = useSettings.getState;
  const isPreset = (c: string) => ACCENTS.some((a) => a.toLowerCase() === c.toLowerCase());
  const custom = accent !== '' && !isPreset(accent);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {/* The theme's own accent: a pill with a word, so it never reads as one more preset. */}
      <button type="button" onClick={() => set().setAccent('')} title="Theme default" aria-label="Theme default accent" aria-pressed={accent === ''}
        style={{ ...dot('var(--color-elevated)', accent === ''), width: 'auto', padding: '0 10px 0 4px', gap: 6, borderRadius: 'var(--radius-xl)' }}>
        <span aria-hidden style={{ width: 20, height: 20, borderRadius: '50%', background: themeAccent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {accent === '' ? <Check size={12} weight="bold" color={onAccent(themeAccent)} /> : <Palette size={12} weight="bold" color={onAccent(themeAccent)} />}
        </span>
        <span style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}>Theme</span>
      </button>
      {ACCENTS.map((c) => {
        const on = accent.toLowerCase() === c.toLowerCase();
        return (
          <button key={c} type="button" onClick={() => set().setAccent(c)} title={c} aria-label={`Accent ${c}`} aria-pressed={on} style={dot(c, on)}>
            {on && <Check size={14} weight="bold" color={onAccent(c)} />}
          </button>
        );
      })}
      {/* literal color: the rainbow of the custom color picker is a picture of "any color", the same in every theme. */}
      <label title="Custom color" style={{ ...dot('conic-gradient(from 90deg, #f0616d, #f5c542, #30d158, #56b6c2, #5a8dd6, #c792ea, #ff6ac1, #f0616d)', custom) }}>
        {custom && <span aria-hidden style={{ width: 14, height: 14, borderRadius: '50%', background: accent, boxShadow: '0 0 0 2px var(--color-pane)' }} />}
        <input type="color" aria-label="Custom accent color" value={accent || shownAccent} onChange={(e) => set().setAccent(e.target.value)} style={{ position: 'absolute', inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)', opacity: 0, cursor: 'pointer', border: 'none', padding: 0, background: 'none' }} />
      </label>
    </div>
  );
}

function themeName(setting: string): string {
  if (setting === 'system') return 'System';
  return getTheme(setting)?.name ?? 'Dispatch Dark';
}

/** The theme's preview as the Theme row's value: a small swatch and the name. */
function ThemeValue({ setting }: { setting: string }) {
  const theme = getTheme(setting);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span style={{ width: 34, flexShrink: 0 }}>{setting === 'system' || !theme ? <SystemSwatch height={22} /> : <Swatch theme={theme} height={22} />}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{themeName(setting)}</span>
    </span>
  );
}

/**
 * Settings → Appearance: how Dispatch looks and behaves on THIS device. Every value here is
 * saved in this browser only (localStorage), so a phone and a Mac can differ.
 */
export function AppearanceSection() {
  const theme = useSettings((s) => s.theme);
  const accent = useSettings((s) => s.accent);
  const fontSize = useSettings((s) => s.fontSize);
  const textScale = useSettings((s) => s.textScale);
  const scrollback = useSettings((s) => s.scrollback);
  const sidebarFontSize = useSettings((s) => s.sidebarFontSize);
  const projectFontSize = useSettings((s) => s.projectFontSize);
  const density = useSettings((s) => s.density);
  const sidebarMaxThreads = useSettings((s) => s.sidebarMaxThreads);
  const sidebarMaxFiles = useSettings((s) => s.sidebarMaxFiles);
  const showPinnedFiles = useSettings((s) => s.showPinnedFiles);
  const showPrettyHint = useSettings((s) => s.showPrettyHint);
  const ptyAutocorrect = useSettings((s) => s.ptyAutocorrect);
  const multiPane = useSettings((s) => s.multiPane);
  const editor = useSettings((s) => s.editor);
  const set = useSettings.getState;
  const [themesOpen, setThemesOpen] = useState(false);
  // The swatches show the pick; only a custom color, which has no swatch of its own, says it in words.
  const accentName = accent !== '' && !ACCENTS.some((a) => a.toLowerCase() === accent.toLowerCase()) ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: fontVar(12) }}>{accent.toUpperCase()}</span> : null;

  return (
    <SettingsPage intro="These settings apply to this device only, so a phone and a computer can differ.">
      <SettingsGroup title="Theme">
        <SettingsRow label="Theme" ariaLabel={`Theme: ${themeName(theme)}`} value={<ThemeValue setting={theme} />} onClick={() => setThemesOpen(true)} />
        <SettingsRow label="Accent" hint="Buttons, switches and highlights." value={accentName}>
          <AccentPicker />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Text size">
        <SettingsRow label="Text scale"
          control={<Slider label="Text scale" value={Math.round(textScale * 100)} min={75} max={150} step={5} defaultValue={100} display={`${Math.round(textScale * 100)}%`} onChange={(v) => set().setTextScale(v / 100)} onReset={() => set().resetTextScale()} />} />
        <SettingsRow label="Terminal" control={<Stepper value={String(fontSize)} onDec={() => set().setFontSize(fontSize - 1)} onInc={() => set().setFontSize(fontSize + 1)} />} />
        <SettingsRow label="Project names" control={<Stepper value={String(projectFontSize)} onDec={() => set().setProjectFontSize(projectFontSize - 1)} onInc={() => set().setProjectFontSize(projectFontSize + 1)} />} />
        <SettingsRow label="Thread and file names" control={<Stepper value={String(sidebarFontSize)} onDec={() => set().setSidebarFontSize(sidebarFontSize - 1)} onInc={() => set().setSidebarFontSize(sidebarFontSize + 1)} />} />
      </SettingsGroup>

      <SettingsGroup title="Sidebar" footer="Longer lists fold behind a “Show more” row. Step past 50 for All.">
        <SettingsRow label="Density" hint="The space around each row in the sidebar.">
          <Segmented ariaLabel="Density" value={density} options={DENSITIES} onChange={(v) => set().setDensity(v as Density)} />
        </SettingsRow>
        <SettingsRow label="Threads shown" control={<Stepper value={formatSidebarLimit(sidebarMaxThreads)} onDec={() => set().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, -1))} onInc={() => set().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, 1))} />} />
        <SettingsRow label="Pinned files" hint="The Files shelf in each project."
          control={<Toggle on={showPinnedFiles} label="Pinned files" onClick={() => set().setShowPinnedFiles(!showPinnedFiles)} />} />
        {/* The master switch comes first and the count hides with the shelf: a "Files shown"
            stepper that still moved while no shelf existed would report a setting nothing obeys. */}
        {showPinnedFiles && (
          <SettingsRow label="Files shown" control={<Stepper value={formatSidebarLimit(sidebarMaxFiles)} onDec={() => set().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, -1))} onInc={() => set().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, 1))} />} />
        )}
      </SettingsGroup>

      <SettingsGroup title="Terminal">
        <SettingsRow label="Scrollback" control={<Stepper value={scrollback.toLocaleString()} unit=" lines" onDec={() => set().setScrollback(scrollback - 5000)} onInc={() => set().setScrollback(scrollback + 5000)} />} />
        <SettingsRow label="Autocorrect" hint="Spelling help in a CLI thread's composer on a phone."
          control={<Toggle on={ptyAutocorrect} label="Autocorrect in the terminal composer" onClick={() => set().setPtyAutocorrect(!ptyAutocorrect)} />} />
        <SettingsRow label="Pretty hint" hint="The “Read best in Pretty” bar on CLI threads."
          control={<Toggle on={showPrettyHint} label="Pretty hint" onClick={() => set().setShowPrettyHint(!showPrettyHint)} />} />
      </SettingsGroup>

      <SettingsGroup title="Workspace">
        <SettingsRow label="Multi-pane tabs (Operator)" hint="Drag tabs to rearrange or split them."
          control={<Toggle on={multiPane} label="Multi-pane tabs (Operator)" onClick={() => set().setMultiPane(!multiPane)} />} />
        <SettingsRow label="Open docs in" hint="Where “Open in editor” opens a doc."
          control={<Select ariaLabel="Open docs in" value={editor} onChange={(v) => set().setEditor(v as DocEditor)} style={{ width: 140 }} options={DOC_EDITORS} />} />
      </SettingsGroup>

      <Sheet open={themesOpen} onClose={() => setThemesOpen(false)} title="Theme">
        <ThemePicker />
      </Sheet>
    </SettingsPage>
  );
}
