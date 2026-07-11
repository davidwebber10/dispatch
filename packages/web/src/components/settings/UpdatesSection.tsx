import { useState } from 'react';
import { useUpdate } from '../../stores/update';
import { useApplyUpdate } from '../update/useApplyUpdate';

const sectionLabel: React.CSSProperties = { font: '500 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 };
const item: React.CSSProperties = { fontSize: 13, color: '#c9c9cf' };
const ghostBtn: React.CSSProperties = { height: 30, padding: '0 14px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12.5, cursor: 'pointer' };

/**
 * Settings → UPDATES: always-reachable update surface (the modal can be
 * dismissed — or missed entirely on the PWA before it was a modal). Shows the
 * running version, checks GitHub on demand, and applies + auto-refreshes.
 */
export function UpdatesSection() {
  const available = useUpdate((s) => s.available);
  const currentVersion = useUpdate((s) => s.currentVersion);
  const { apply, applying, failReason, inProgress } = useApplyUpdate();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [checkError, setCheckError] = useState(false);

  async function check() {
    setChecking(true); setChecked(false); setCheckError(false);
    try { await useUpdate.getState().check(); setChecked(true); }
    catch { setCheckError(true); }
    setChecking(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>UPDATES</span>
      <div style={row}>
        <span style={item}>Version</span>
        <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)' }}>{currentVersion ? `Dispatch v${currentVersion}` : 'Dispatch'}</span>
      </div>
      {inProgress ? (
        <div style={{ fontSize: 12.5, color: 'var(--color-accent)' }}>Updating — this page will refresh automatically when the server is back.</div>
      ) : available ? (
        <div style={row}>
          <span style={{ ...item, color: 'var(--color-accent)', fontWeight: 600 }}>{available.version} is available</span>
          <button onClick={() => void apply()} disabled={applying} style={{ height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: 'pointer', opacity: applying ? 0.7 : 1 }}>
            {applying ? 'Updating…' : 'Update now'}
          </button>
        </div>
      ) : (
        <div style={row}>
          <button onClick={() => void check()} disabled={checking} style={{ ...ghostBtn, opacity: checking ? 0.6 : 1 }}>{checking ? 'Checking…' : 'Check for updates'}</button>
          {checked && !checkError && <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>You're up to date.</span>}
          {checkError && <span style={{ fontSize: 12, color: 'var(--color-status-red)' }}>Couldn't reach the server.</span>}
        </div>
      )}
      {failReason && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
          Couldn't update automatically: {failReason} Run <code style={{ font: '400 11px var(--font-mono)' }}>dispatch update</code> manually instead.
        </div>
      )}
    </div>
  );
}
