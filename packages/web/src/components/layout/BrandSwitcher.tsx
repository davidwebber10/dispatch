import { useState } from 'react';
import { Terminal } from '@phosphor-icons/react';
import { useServers, currentServer, currentLabel } from '../../stores/servers';
import { useUpdate } from '../../stores/update';

export function BrandSwitcher() {
  const [open, setOpen] = useState(false);
  // Same source as the Settings version line: the connected daemon's running version,
  // loaded into the update store at startup (App bootstrap → GET /api/state/update).
  const version = useUpdate((s) => s.currentVersion);
  const servers = useServers((s) => s.servers);
  const origin = window.location.origin;
  const label = currentLabel(servers, origin);
  // When the current origin isn't one of the configured servers (local dev or the
  // hosted domain), surface it as its own "Local" entry at the top of the list.
  const items = currentServer(servers, origin) ? servers : [{ label, origin }, ...servers];

  function go(target: string) {
    setOpen(false);
    if (target !== origin) window.location.href = target + window.location.pathname;
  }

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="Switch server" style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, height: 30, padding: '0 9px 0 6px',
        background: open ? 'var(--color-elevated)' : 'transparent', border: '1px solid', borderColor: open ? '#2C2C32' : 'transparent',
        borderRadius: 8, cursor: 'pointer',
      }}>
        <span style={{ width: 17, height: 17, borderRadius: 5, background: 'var(--color-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Terminal size={11} weight="bold" color="#08240F" /></span>
        <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.3px', color: 'var(--color-text-primary)' }}>Dispatch</span>
        {version && <span title="Daemon version" style={{ font: '500 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>v{version}</span>}
        <span style={{ font: '500 12px var(--font-mono)', color: 'var(--color-text-secondary)' }}>{label}</span>
        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{ position: 'absolute', top: 36, left: 0, zIndex: 91, minWidth: 250, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            <div style={{ font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', padding: '6px 8px 5px' }}>SERVER</div>
            {items.map((s) => {
              const active = s.origin === origin;
              return (
                <button key={s.origin} onClick={() => go(s.origin)} style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 8px',
                  background: active ? 'var(--color-hover)' : 'transparent', border: 'none', borderRadius: 6,
                  color: 'var(--color-text-primary)', cursor: 'pointer', textAlign: 'left',
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: active ? 'var(--color-accent)' : '#46464d' }} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>Dispatch {s.label}</span>
                    <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{new URL(s.origin).host}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
