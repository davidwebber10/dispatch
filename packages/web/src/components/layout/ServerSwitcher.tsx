import { useState } from 'react';
import { SERVERS, currentLabel } from '../../servers';

export function ServerSwitcher() {
  const [open, setOpen] = useState(false);
  const origin = window.location.origin;
  const label = currentLabel(origin);

  function go(target: string) {
    setOpen(false);
    if (target !== origin) window.location.href = target + window.location.pathname;
  }

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px',
        background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7,
        color: 'var(--color-text-secondary)', font: '500 11px var(--font-mono)', cursor: 'pointer',
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)' }} />
        {label}
        <span style={{ color: 'var(--color-text-tertiary)' }}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90 }} />
          <div style={{ position: 'absolute', top: 30, right: 0, zIndex: 91, minWidth: 230, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            {SERVERS.map((s) => {
              const active = s.origin === origin;
              return (
                <button key={s.origin} onClick={() => go(s.origin)} style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%', padding: '6px 8px',
                  background: active ? 'var(--color-hover)' : 'transparent', border: 'none', borderRadius: 6,
                  color: 'var(--color-text-primary)', cursor: 'pointer', textAlign: 'left',
                }}>
                  <span style={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>{s.label}{active ? ' ·' : ''}</span>
                  <span style={{ font: '400 10px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{new URL(s.origin).host}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
