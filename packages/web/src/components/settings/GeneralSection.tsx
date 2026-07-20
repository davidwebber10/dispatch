import { useState } from 'react';
import { useConnection } from '../../stores/connection';
import { useSettings, ACCENTS } from '../../stores/settings';
import { useServers, currentLabel } from '../../stores/servers';
import { useSetup } from '../../stores/setup';
import { UpdatesSection } from './UpdatesSection';
import { MultiPaneSetting } from '../panes/MultiPaneSetting';
import { sectionLabel, row, item, chip, Divider, Toggle, Stepper } from './ui';

function ServersSection() {
  const servers = useServers((s) => s.servers);
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canAdd = !!label.trim() && !!origin.trim() && !busy;

  const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useServers.getState().add(label.trim(), origin.trim()); setLabel(''); setOrigin(''); }
    catch { setErr('Could not add — origin must be an http(s) URL.'); }
    setBusy(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>SERVERS</span>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Switch between machines from the brand menu. Stored on this daemon.</div>
      {servers.map((s) => (
        <div key={s.origin} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 13, color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
            <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.origin}</span>
          </span>
          <button title="Remove server" onClick={() => void useServers.getState().remove(s.origin)} style={{ width: 26, height: 26, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" style={{ ...input, flex: '0 0 34%' }} />
        <input value={origin} onChange={(e) => setOrigin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="https://host:3456" style={{ ...input, flex: 1 }} />
        <button onClick={() => void add()} disabled={!canAdd} style={{ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: canAdd ? 'pointer' : 'default', opacity: canAdd ? 1 : 0.5 }}>Add</button>
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}

/**
 * `onDone` dismisses the surrounding chrome. On desktop that closes the settings
 * modal (so the setup wizard isn't buried under it); on mobile settings is a screen
 * rather than an overlay, so nothing needs dismissing and the prop is omitted.
 */
export function GeneralSection({ onDone }: { onDone?: () => void }) {
  const status = useConnection((s) => s.status);
  const fontSize = useSettings((s) => s.fontSize);
  const scrollback = useSettings((s) => s.scrollback);
  const sidebarFontSize = useSettings((s) => s.sidebarFontSize);
  const projectFontSize = useSettings((s) => s.projectFontSize);
  const accent = useSettings((s) => s.accent);
  const density = useSettings((s) => s.density);
  const coordinatorName = useSettings((s) => s.coordinatorName);
  const pushEnabled = useSettings((s) => s.pushEnabled);
  const [pushMsg, setPushMsg] = useState('');
  const servers = useServers((s) => s.servers);
  const openSetup = useSetup((s) => s.open);

  async function togglePush() {
    setPushMsg('');
    try { await useSettings.getState().setPushEnabled(!pushEnabled); }
    catch (e: any) {
      const { pushErrorMessage } = await import('../../lib/push');
      setPushMsg(pushErrorMessage(String(e?.message)));
    }
  }

  const st = status === 'open' ? { c: 'var(--color-accent)', t: 'Connected' } : status === 'connecting' ? { c: 'var(--color-status-yellow)', t: 'Connecting' } : { c: 'var(--color-status-red)', t: 'Offline' };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>GETTING STARTED</span>
        <button onClick={() => { openSetup(); onDone?.(); }} style={{ alignSelf: 'flex-start', height: 30, padding: '0 14px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12.5, cursor: 'pointer' }}>Re-run setup wizard</button>
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>COORDINATOR</span>
        <div style={row}>
          <span style={item}>Name</span>
          <input
            value={coordinatorName}
            onChange={(e) => useSettings.getState().setCoordinatorName(e.target.value)}
            placeholder="Control Plane"
            aria-label="Coordinator name"
            style={{ width: 180, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' }}
          />
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Shown wherever your coordinator appears. Leave blank to use “Control Plane”.</div>
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>CONNECTION</span>
        <div style={row}><span style={item}>Server</span><span style={chip}>{currentLabel(servers)}</span></div>
        <div style={row}><span style={item}>Connection</span><span style={{ display: 'flex', alignItems: 'center', gap: 6, font: '500 11px var(--font-mono)', color: st.c }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: st.c }} />{st.t}</span></div>
      </div>
      <Divider />

      <ServersSection />
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>TERMINAL</span>
        <div style={row}><span style={item}>Font size</span><Stepper value={String(fontSize)} onDec={() => useSettings.getState().setFontSize(fontSize - 1)} onInc={() => useSettings.getState().setFontSize(fontSize + 1)} /></div>
        <div style={row}><span style={item}>Scrollback</span><Stepper value={scrollback.toLocaleString()} unit=" lines" onDec={() => useSettings.getState().setScrollback(scrollback - 5000)} onInc={() => useSettings.getState().setScrollback(scrollback + 5000)} /></div>
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>SIDEBAR</span>
        <div style={row}><span style={item}>Project names</span><Stepper value={String(projectFontSize)} onDec={() => useSettings.getState().setProjectFontSize(projectFontSize - 1)} onInc={() => useSettings.getState().setProjectFontSize(projectFontSize + 1)} /></div>
        <div style={row}><span style={item}>Thread &amp; file names</span><Stepper value={String(sidebarFontSize)} onDec={() => useSettings.getState().setSidebarFontSize(sidebarFontSize - 1)} onInc={() => useSettings.getState().setSidebarFontSize(sidebarFontSize + 1)} /></div>
        <div style={row}><span style={item}>Density</span>
          <div style={{ display: 'inline-flex', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, padding: 2, gap: 2 }}>
            {(['compact', 'cozy', 'roomy'] as const).map((d) => (
              <button key={d} onClick={() => useSettings.getState().setDensity(d)} style={{
                padding: '4px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', textTransform: 'capitalize',
                fontSize: 12, fontWeight: density === d ? 600 : 400,
                background: density === d ? 'var(--color-accent)' : 'transparent',
                color: density === d ? '#08240F' : 'var(--color-text-secondary)',
              }}>{d}</button>
            ))}
          </div>
        </div>
      </div>
      <Divider />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={sectionLabel}>APPEARANCE</span>
        <div style={row}><span style={item}>Theme</span><span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, padding: '5px 11px' }}><span style={{ width: 11, height: 11, borderRadius: 3, background: '#0f0f11', border: '1px solid #46464d' }} />Dark</span></div>
        <div style={{ ...row, alignItems: 'flex-start' }}><span style={{ ...item, paddingTop: 3 }}>Accent</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 360 }}>
            {ACCENTS.map((c) => (
              <button key={c} onClick={() => useSettings.getState().setAccent(c)} title={c} style={{ width: 19, height: 19, borderRadius: 5, background: c, border: 'none', cursor: 'pointer', flexShrink: 0, outline: accent.toLowerCase() === c.toLowerCase() ? `2px solid ${c}` : '2px solid transparent', outlineOffset: 2 }} />
            ))}
            <label title="Custom color" style={{ position: 'relative', width: 19, height: 19, borderRadius: 5, cursor: 'pointer', overflow: 'hidden', flexShrink: 0, background: 'conic-gradient(from 90deg, #f0616d, #f5c542, #30d158, #56b6c2, #5a8dd6, #c792ea, #ff6ac1, #f0616d)', outline: ACCENTS.some((a) => a.toLowerCase() === accent.toLowerCase()) ? '2px solid transparent' : `2px solid ${accent}`, outlineOffset: 2 }}>
              <input type="color" value={accent} onChange={(e) => useSettings.getState().setAccent(e.target.value)} style={{ position: 'absolute', inset: -6, width: 'calc(100% + 12px)', height: 'calc(100% + 12px)', opacity: 0, cursor: 'pointer', border: 'none', padding: 0, background: 'none' }} />
            </label>
          </div>
        </div>
      </div>
      <Divider />

      <div style={row}><span style={item}>Push notifications on this device</span><Toggle on={pushEnabled} onClick={() => void togglePush()} /></div>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Alerts are armed per thread with the bell — this enables this device to receive them.</div>
      {pushMsg && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>{pushMsg}</div>}
      <Divider />

      <MultiPaneSetting />
      <Divider />

      <UpdatesSection />
    </>
  );
}
