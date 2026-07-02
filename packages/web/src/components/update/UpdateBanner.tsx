import { useState } from 'react';
import { api } from '../../api/client';
import { useUpdate } from '../../stores/update';

const primary: React.CSSProperties = { height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const ghost: React.CSSProperties = { height: 28, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };
const wrapper: React.CSSProperties = { position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 199, width: 480, maxWidth: '92vw', background: '#1B1B1E', border: '1px solid #2C3A4A', borderRadius: 12, padding: 14, boxShadow: '0 20px 60px -20px rgba(0,0,0,.8)' };

export function UpdateBanner() {
  const available = useUpdate((s) => s.available);
  const dismissedVersion = useUpdate((s) => s.dismissedVersion);
  const inProgress = useUpdate((s) => s.inProgress);
  const [applying, setApplying] = useState(false);
  const [failReason, setFailReason] = useState<string | null>(null);

  if (inProgress) {
    return (
      <div style={wrapper}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--color-accent)' }}>⟳</span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Updating — Dispatch will restart in a few seconds…</span>
        </div>
      </div>
    );
  }

  if (!available || available.version === dismissedVersion) return null;

  const applyUpdate = async () => {
    setApplying(true);
    setFailReason(null);
    try {
      const res = await api.applyUpdate();
      if (res.ok) {
        useUpdate.setState({ inProgress: true });
      } else {
        setFailReason(res.reason ?? 'Update could not be applied automatically.');
      }
    } catch {
      setFailReason('Could not reach the server to apply the update.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div style={wrapper}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--color-accent)' }}>⬆</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>A new version ({available.version}) is available</span>
        <button onClick={() => void applyUpdate()} disabled={applying} style={{ marginLeft: 'auto', ...primary, opacity: applying ? 0.7 : 1 }}>{applying ? 'Updating…' : 'Update'}</button>
        <button onClick={() => useUpdate.getState().dismiss()} style={ghost}>Dismiss</button>
      </div>
      {failReason && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
          Couldn't update automatically: {failReason}
          <br />
          Run it manually instead: <code style={{ font: '400 11px var(--font-mono)' }}>dispatch update</code>
        </div>
      )}
    </div>
  );
}
