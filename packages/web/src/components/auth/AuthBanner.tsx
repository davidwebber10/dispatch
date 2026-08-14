import { useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../stores/auth';
import { useTabs, findTerminal } from '../../stores/tabs';

const primary: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 28, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };

export function AuthBanner() {
  // Select the STABLE array and derive here. A selector that returns `.filter(...)` hands
  // zustand a new array every render, so its snapshot never settles and React loops until
  // it throws "Maximum update depth exceeded".
  const requests = useAuth((s) => s.requests);
  const pending = requests.filter((r) => r.status === 'pending' || r.status === 'opened');
  const req = pending[0];
  // Resolve which agent/mission needs auth (falls back to generic copy if the
  // terminal's project tabs haven't been loaded, or this request predates terminalId).
  const agentLabel = useTabs((s) => (req?.terminalId ? findTerminal(s.byProject, req.terminalId)?.label : undefined));
  const [cb, setCb] = useState('');
  if (!req) return null;

  const submit = async () => { if (cb.trim()) { await api.forwardAuthCallback(req.id, cb.trim()); setCb(''); } };

  return (
    <div style={{ position: 'fixed', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 200, width: 560, maxWidth: '92vw', background: '#1B1B1E', border: '1px solid #4A3D18', borderRadius: 12, padding: 14, boxShadow: '0 20px 60px -20px rgba(0,0,0,.8)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--color-status-yellow)' }}>🔑</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{agentLabel ? `Authentication required — ${agentLabel}` : 'Authentication required'}</span>
        {pending.length > 1 && (
          <span style={{ font: '500 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>1 of {pending.length}</span>
        )}
        {/* Dismiss clears the whole queue, not just the top one: a burst used to cost one
            tap each, with the next appearing the instant you cleared the last. */}
        <button onClick={() => void api.dismissAllAuth()} style={{ marginLeft: 'auto', ...ghost }}>
          {pending.length > 1 ? 'Dismiss all' : 'Dismiss'}
        </button>
      </div>
      <div style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)', margin: '8px 0', wordBreak: 'break-all' }}>{req.url}</div>
      {/* A real anchor (not window.open) so a PWA opens the SYSTEM browser — Safari
          on iOS, the default browser on Mac — instead of an in-app browser. On the
          daemon's own device the localhost OAuth callback then returns automatically. */}
      <a
        href={req.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => { void api.markAuthOpened(req.id); }}
        style={{ ...primary, display: 'inline-flex', alignItems: 'center', textDecoration: 'none', lineHeight: '30px' }}
      >
        Open in browser ↗
      </a>
      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-text-tertiary)' }}>On this Mac it returns automatically. From another device (e.g. iPhone), copy the <code>localhost</code> URL Safari lands on and paste it here:</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <input value={cb} onChange={(e) => setCb(e.target.value)} placeholder="http://localhost:…/callback?code=…" style={{ flex: 1, height: 30, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 11px var(--font-mono)' }} />
        <button onClick={() => void submit()} style={ghost}>Forward</button>
      </div>
    </div>
  );
}
