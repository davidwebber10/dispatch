import { useSettings, ACCENTS, formatSidebarLimit, stepSidebarLimit, type DocEditor } from '../../stores/settings';
import { THEMES, SYSTEM_DARK, SYSTEM_LIGHT, resolveTokens, type Theme } from '../../themes';
import { useActiveTheme } from '../../themes/apply';
import { MultiPaneSetting } from '../panes/MultiPaneSetting';
import { sectionLabel, summaryLine, row, item, Divider, Toggle, Stepper } from './ui';
import { Select } from '../common/Select';

const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const group: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const select: React.CSSProperties = { height: 30, width: 140, font: '400 12px var(--font-sans)' };
const DOC_EDITORS = [{ value: '', label: 'None' }, { value: 'vscode', label: 'VS Code' }, { value: 'cursor', label: 'Cursor' }, { value: 'zed', label: 'Zed' }];

const tileGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))', gap: 8 };
const subLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '0.6px', color: 'var(--color-text-tertiary)', margin: '2px 0 -2px' };

/** A theme in miniature: its canvas, a pane, two lines of text and the accent. Colors are the theme's own values. */
function Swatch({ theme }: { theme: Theme }) {
  const tk = resolveTokens(theme);
  return (
    <span data-testid="theme-swatch" aria-hidden="true" style={{ position: 'relative', display: 'block', height: 44, borderRadius: 'var(--radius-sm)', background: tk.canvas, border: `1px solid ${tk.border}`, overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: 6, top: 6, right: 6, bottom: 6, borderRadius: 'var(--radius-xs)', background: tk.pane, border: `1px solid ${tk.border}` }}>
        <span style={{ position: 'absolute', left: 6, top: 6, width: '55%', height: 4, borderRadius: 'var(--radius-xs)', background: tk['text-primary'] }} />
        <span style={{ position: 'absolute', left: 6, top: 14, width: '38%', height: 4, borderRadius: 'var(--radius-xs)', background: tk['text-secondary'] }} />
        <span style={{ position: 'absolute', right: 6, bottom: 5, width: 16, height: 8, borderRadius: 'var(--radius-xs)', background: tk.accent }} />
      </span>
    </span>
  );
}

function ThemeTile({ label, on, onPick, children }: { label: string; on: boolean; onPick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={label} onClick={onPick}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6, minWidth: 0, background: on ? 'var(--color-hover)' : 'transparent', border: `1px solid ${on ? 'var(--color-accent)' : 'var(--color-border-strong)'}`, borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left' }}>
      {children}
      <span style={{ fontSize: 12, fontWeight: on ? 600 : 400, color: on ? 'var(--color-text-primary)' : 'var(--color-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}

/** Settings → Appearance → Theme: System first, then the light themes, then the dark ones. Picking one applies it at once. */
function ThemePicker() {
  const setting = useSettings((s) => s.theme);
  const pick = (id: string) => useSettings.getState().setTheme(id);
  const light = THEMES.filter((t) => t.kind === 'light');
  const dark = THEMES.filter((t) => t.kind === 'dark');
  return (
    <div role="radiogroup" aria-label="Theme" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={tileGrid}>
        <ThemeTile label="System" on={setting === 'system'} onPick={() => pick('system')}>
          {/* Half Dispatch Light, half Dispatch Dark: the device's setting picks. */}
          <span style={{ position: 'relative', display: 'block', height: 44 }}>
            <span style={{ position: 'absolute', inset: 0, clipPath: 'polygon(0 0, 100% 0, 0 100%)' }}><Swatch theme={SYSTEM_LIGHT} /></span>
            <span style={{ position: 'absolute', inset: 0, clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}><Swatch theme={SYSTEM_DARK} /></span>
          </span>
        </ThemeTile>
      </div>
      <span style={subLabel}>LIGHT</span>
      <div style={tileGrid}>
        {light.map((t) => <ThemeTile key={t.id} label={t.name} on={setting === t.id} onPick={() => pick(t.id)}><Swatch theme={t} /></ThemeTile>)}
      </div>
      <span style={subLabel}>DARK</span>
      <div style={tileGrid}>
        {dark.map((t) => <ThemeTile key={t.id} label={t.name} on={setting === t.id} onPick={() => pick(t.id)}><Swatch theme={t} /></ThemeTile>)}
      </div>
    </div>
  );
}

/**
 * Settings → Appearance: how Dispatch looks and behaves on THIS device. Every value here is
 * saved in this browser only (localStorage), so a phone and a Mac can differ.
 */
export function AppearanceSection() {
  const fontSize = useSettings((s) => s.fontSize);
  const scrollback = useSettings((s) => s.scrollback);
  const sidebarFontSize = useSettings((s) => s.sidebarFontSize);
  const projectFontSize = useSettings((s) => s.projectFontSize);
  const accent = useSettings((s) => s.accent);
  // The accent on screen: the user's, or the theme's when the setting is '' (Theme default).
  const shownAccent = useActiveTheme((s) => s.accent);
  const density = useSettings((s) => s.density);
  const sidebarMaxThreads = useSettings((s) => s.sidebarMaxThreads);
  const sidebarMaxFiles = useSettings((s) => s.sidebarMaxFiles);
  const showPinnedFiles = useSettings((s) => s.showPinnedFiles);
  const showPrettyHint = useSettings((s) => s.showPrettyHint);
  const ptyAutocorrect = useSettings((s) => s.ptyAutocorrect);
  const editor = useSettings((s) => s.editor);
  const set = useSettings.getState;

  return (
    <>
      <div style={summaryLine}>THIS DEVICE · everything here applies to this device only.</div>

      <div style={group}>
        <span style={sectionLabel}>THEME</span>
        <ThemePicker />
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>COLOR</span>
        <div style={{ ...row, alignItems: 'flex-start' }}><span style={{ ...item, paddingTop: 3 }}>Accent</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', maxWidth: 360 }}>
            <button type="button" onClick={() => set().setAccent('')} title="Theme default" aria-label="Theme default accent" aria-pressed={accent === ''}
              style={{ height: 19, padding: '0 7px', display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 'var(--radius-sm)', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', color: 'var(--color-text-secondary)', font: '500 10.5px var(--font-sans)', cursor: 'pointer', flexShrink: 0, outline: accent === '' ? '2px solid var(--color-accent)' : '2px solid transparent', outlineOffset: 2 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)' }} />Theme
            </button>
            {ACCENTS.map((c) => (
              <button key={c} onClick={() => set().setAccent(c)} title={c} aria-label={`Accent ${c}`} style={{ width: 19, height: 19, borderRadius: 'var(--radius-sm)', background: c, border: 'none', cursor: 'pointer', flexShrink: 0, outline: accent.toLowerCase() === c.toLowerCase() ? `2px solid ${c}` : '2px solid transparent', outlineOffset: 2 }} />
            ))}
            {/* literal color: the rainbow of the custom color picker is a picture of "any color", the same in every theme. */}
            <label title="Custom color" style={{ position: 'relative', width: 19, height: 19, borderRadius: 'var(--radius-sm)', cursor: 'pointer', overflow: 'hidden', flexShrink: 0, background: 'conic-gradient(from 90deg, #f0616d, #f5c542, #30d158, #56b6c2, #5a8dd6, #c792ea, #ff6ac1, #f0616d)', outline: accent === '' || ACCENTS.some((a) => a.toLowerCase() === accent.toLowerCase()) ? '2px solid transparent' : `2px solid ${accent}`, outlineOffset: 2 }}>
              <input type="color" aria-label="Custom accent color" value={accent || shownAccent} onChange={(e) => set().setAccent(e.target.value)} style={{ position: 'absolute', inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)', opacity: 0, cursor: 'pointer', border: 'none', padding: 0, background: 'none' }} />
            </label>
          </div>
        </div>
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>TEXT SIZE</span>
        <div style={row}><span style={item}>Terminal</span><Stepper value={String(fontSize)} onDec={() => set().setFontSize(fontSize - 1)} onInc={() => set().setFontSize(fontSize + 1)} /></div>
        <div style={row}><span style={item}>Project names</span><Stepper value={String(projectFontSize)} onDec={() => set().setProjectFontSize(projectFontSize - 1)} onInc={() => set().setProjectFontSize(projectFontSize + 1)} /></div>
        <div style={row}><span style={item}>Thread &amp; file names</span><Stepper value={String(sidebarFontSize)} onDec={() => set().setSidebarFontSize(sidebarFontSize - 1)} onInc={() => set().setSidebarFontSize(sidebarFontSize + 1)} /></div>
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>SIDEBAR</span>
        <div style={row}><span style={item}>Density</span>
          <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', padding: 2, gap: 2 }}>
            {(['compact', 'cozy', 'roomy'] as const).map((d) => (
              <button key={d} onClick={() => set().setDensity(d)} style={{
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                fontSize: 12, fontWeight: density === d ? 600 : 400,
                background: density === d ? 'var(--color-accent)' : 'transparent',
                color: density === d ? 'var(--color-on-accent)' : 'var(--color-text-secondary)',
              }}>{d}</button>
            ))}
          </div>
        </div>
        <div style={row}><span style={item}>Threads shown</span><Stepper value={formatSidebarLimit(sidebarMaxThreads)} onDec={() => set().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, -1))} onInc={() => set().setSidebarMaxThreads(stepSidebarLimit(sidebarMaxThreads, 1))} /></div>
        <div style={row}><span style={item}>Pinned files</span><Toggle on={showPinnedFiles} label="Pinned files" onClick={() => set().setShowPinnedFiles(!showPinnedFiles)} /></div>
        <div style={note}>Off hides the FILES shelf from every project. Pinning and “Browse Files” still work.</div>
        {/* The master switch comes first and the count hides with the shelf: a "Files shown"
            stepper that still moved while no shelf existed would report a setting nothing obeys. */}
        {showPinnedFiles && (
          <div style={row}><span style={item}>Files shown</span><Stepper value={formatSidebarLimit(sidebarMaxFiles)} onDec={() => set().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, -1))} onInc={() => set().setSidebarMaxFiles(stepSidebarLimit(sidebarMaxFiles, 1))} /></div>
        )}
        <div style={note}>Longer lists collapse behind a “Show more” row. Step past 50 for All.</div>
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>TERMINAL</span>
        <div style={row}><span style={item}>Scrollback</span><Stepper value={scrollback.toLocaleString()} unit=" lines" onDec={() => set().setScrollback(scrollback - 5000)} onInc={() => set().setScrollback(scrollback + 5000)} /></div>
        <div style={row}><span style={item}>Autocorrect</span><Toggle on={ptyAutocorrect} label="Autocorrect in the terminal composer" onClick={() => set().setPtyAutocorrect(!ptyAutocorrect)} /></div>
        <div style={note}>Spelling help in a CLI thread's composer on a phone. The terminal's + menu has the same switch, for a run of shell commands.</div>
        <div style={row}><span style={item}>Pretty hint</span><Toggle on={showPrettyHint} label="Pretty hint" onClick={() => set().setShowPrettyHint(!showPrettyHint)} /></div>
        <div style={note}>Off hides the “Long responses read best in Pretty” bar above CLI threads. The CLI/Pretty switch still works.</div>
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>LAYOUT</span>
        <MultiPaneSetting />
      </div>
      <Divider />

      <div style={group}>
        <span style={sectionLabel}>EDITOR</span>
        <div style={row}>
          <label htmlFor="settings-doc-editor" style={item}>Open docs in</label>
          <Select id="settings-doc-editor" value={editor} onChange={(v) => set().setEditor(v as DocEditor)} style={select} options={DOC_EDITORS} />
        </div>
        <div style={note}>The doc viewer's “Open in editor” button opens files in this editor. None hides the button.</div>
      </div>
    </>
  );
}
