import { useState } from 'react';
import { useConnection } from '../../stores/connection';
import { useSettings, ACCENTS } from '../../stores/settings';
import { useServers, currentLabel } from '../../stores/servers';

const sectionLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const item: React.CSSProperties = { fontSize: 13, color: '#c9c9cf' };
const chip: React.CSSProperties = { font: '400 11.5px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, padding: '5px 10px' };

function Divider() { return <div style={{ height: 1, background: 'var(--color-hover)' }} />; }

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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 38, height: 21, borderRadius: 11, border: 'none', cursor: 'pointer', background: on ? 'var(--color-accent)' : '#34343a', position: 'relative', transition: 'background .15s ease', flexShrink: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 19 : 2, width: 17, height: 17, borderRadius: '50%', background: on ? '#08240F' : '#e9e9ec', transition: 'left .15s ease' }} />
    </button>
  );
}

function Stepper({ value, unit, onDec, onInc }: { value: string; unit?: string; onDec: () => void; onInc: () => void }) {
  const btn = (side: 'l' | 'r'): React.CSSProperties => ({ width: 28, height: 28, background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: side === 'l' ? '7px 0 0 7px' : '0 7px 7px 0', color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', font: '500 14px var(--font-sans)' });
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      <button onClick={onDec} style={btn('l')}>−</button>
      <div style={{ height: 28, minWidth: 64, background: '#1b1b1e', borderTop: '1px solid #2c2c32', borderBottom: '1px solid #2c2c32', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 10px', font: '400 11.5px var(--font-mono)', color: '#c9c9cf' }}>{value}{unit ?? ''}</div>
      <button onClick={onInc} style={btn('r')}>+</button>
    </div>
  );
}

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useConnection((s) => s.status);
  const fontSize = useSettings((s) => s.fontSize);
  const scrollback = useSettings((s) => s.scrollback);
  const accent = useSettings((s) => s.accent);
  const notify = useSettings((s) => s.notify);
  const servers = useServers((s) => s.servers);
  if (!open) return null;

  const st = status === 'open' ? { c: 'var(--color-accent)', t: 'Connected' } : status === 'connecting' ? { c: 'var(--color-status-yellow)', t: 'Connecting' } : { c: 'var(--color-status-red)', t: 'Offline' };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', background: '#18181b', border: '1px solid #2f2f35', borderRadius: 14, boxShadow: '0 30px 80px -20px rgba(0,0,0,.85)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--color-hover)' }}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>Settings</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            <span style={sectionLabel}>APPEARANCE</span>
            <div style={row}><span style={item}>Theme</span><span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, padding: '5px 11px' }}><span style={{ width: 11, height: 11, borderRadius: 3, background: '#0f0f11', border: '1px solid #46464d' }} />Dark</span></div>
            <div style={row}><span style={item}>Accent</span><div style={{ display: 'flex', gap: 8 }}>{ACCENTS.map((c) => (
              <button key={c} onClick={() => useSettings.getState().setAccent(c)} title={c} style={{ width: 19, height: 19, borderRadius: 5, background: c, border: 'none', cursor: 'pointer', outline: accent === c ? `2px solid ${c}` : '2px solid transparent', outlineOffset: 2 }} />
            ))}</div></div>
          </div>
          <Divider />

          <div style={row}><span style={item}>Alert when input needed</span><Toggle on={notify} onClick={() => void useSettings.getState().setNotify(!notify)} /></div>
          <Divider />

          <div style={row}><span style={item}>Version</span><span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' }}>Dispatch Web</span></div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 20px', borderTop: '1px solid var(--color-hover)' }}>
          <button onClick={onClose} style={{ height: 34, padding: '0 20px', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  );
}
