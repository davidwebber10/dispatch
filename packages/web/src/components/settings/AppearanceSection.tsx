import { useSettings, ACCENTS, formatSidebarLimit, stepSidebarLimit, type DocEditor } from '../../stores/settings';
import { MultiPaneSetting } from '../panes/MultiPaneSetting';
import { sectionLabel, summaryLine, row, item, Divider, Toggle, Stepper } from './ui';

const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const group: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const select: React.CSSProperties = { height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };

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
        <span style={sectionLabel}>COLOR</span>
        <div style={{ ...row, alignItems: 'flex-start' }}><span style={{ ...item, paddingTop: 3 }}>Accent</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 360 }}>
            {ACCENTS.map((c) => (
              <button key={c} onClick={() => set().setAccent(c)} title={c} aria-label={`Accent ${c}`} style={{ width: 19, height: 19, borderRadius: 'var(--radius-sm)', background: c, border: 'none', cursor: 'pointer', flexShrink: 0, outline: accent.toLowerCase() === c.toLowerCase() ? `2px solid ${c}` : '2px solid transparent', outlineOffset: 2 }} />
            ))}
            <label title="Custom color" style={{ position: 'relative', width: 19, height: 19, borderRadius: 'var(--radius-sm)', cursor: 'pointer', overflow: 'hidden', flexShrink: 0, background: 'conic-gradient(from 90deg, #f0616d, #f5c542, #30d158, #56b6c2, #5a8dd6, #c792ea, #ff6ac1, #f0616d)', outline: ACCENTS.some((a) => a.toLowerCase() === accent.toLowerCase()) ? '2px solid transparent' : `2px solid ${accent}`, outlineOffset: 2 }}>
              <input type="color" aria-label="Custom accent color" value={accent} onChange={(e) => set().setAccent(e.target.value)} style={{ position: 'absolute', inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)', opacity: 0, cursor: 'pointer', border: 'none', padding: 0, background: 'none' }} />
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
          <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 'var(--radius-sm)', padding: 2, gap: 2 }}>
            {(['compact', 'cozy', 'roomy'] as const).map((d) => (
              <button key={d} onClick={() => set().setDensity(d)} style={{
                padding: '4px 10px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                fontSize: 12, fontWeight: density === d ? 600 : 400,
                background: density === d ? 'var(--color-accent)' : 'transparent',
                color: density === d ? '#08240F' : 'var(--color-text-secondary)',
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
          <select id="settings-doc-editor" value={editor} onChange={(e) => set().setEditor(e.target.value as DocEditor)} style={select}>
            <option value="">None</option>
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="zed">Zed</option>
          </select>
        </div>
        <div style={note}>The doc viewer's “Open in editor” button opens files in this editor. None hides the button.</div>
      </div>
    </>
  );
}
