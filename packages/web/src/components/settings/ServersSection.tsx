import { useState } from 'react';
import { useConnection } from '../../stores/connection';
import { useServers, currentLabel } from '../../stores/servers';
import { useIsMobile } from '../../hooks/useIsMobile';
import { sectionLabel, row, item, fieldInput, solidBtn, iconBtn, Divider, CONNECTION_STATUS } from './ui';

const note: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };

/**
 * Settings → Servers: the Dispatch machines this one knows about (switch between them from the brand
 * menu), and this device's connection status. The status is shown once per shell: on desktop it is the
 * settings nav's DAEMON block, so only the phone shows it here, in the same words (ui CONNECTION_STATUS).
 */
export function ServersSection() {
  const status = useConnection((s) => s.status);
  const servers = useServers((s) => s.servers);
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canAdd = !!label.trim() && !!origin.trim() && !busy;
  const conn = CONNECTION_STATUS[status];
  const isMobile = useIsMobile();

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useServers.getState().add(label.trim(), origin.trim()); setLabel(''); setOrigin(''); }
    catch { setErr('Could not add. The address must be an http(s) URL.'); }
    setBusy(false);
  }

  return (
    <>
      {isMobile && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={sectionLabel}>THIS DEVICE</span>
            <div style={row}>
              <span style={item}>Connection</span>
              <span data-testid="connection-status" style={{ display: 'flex', alignItems: 'center', gap: 6, font: '500 11px var(--font-mono)', color: conn.color, minWidth: 0 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: conn.color, flexShrink: 0 }} />
                {conn.label}
                <span style={{ color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {currentLabel(servers)}</span>
              </span>
            </div>
          </div>
          <Divider />
        </>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span style={sectionLabel}>ALL DEVICES</span>
        <div style={note}>Dispatch machines you can switch to from the brand menu. The list is stored on this daemon, so every device sees the same one.</div>
        {servers.map((s) => (
          <div key={s.origin} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <span style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</span>
              <span style={{ font: '400 10.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.origin}</span>
            </span>
            <button title="Remove server" aria-label={`Remove ${s.label}`} onClick={() => void useServers.getState().remove(s.origin)} style={{ ...iconBtn, fontSize: 15, lineHeight: 1 }}>×</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" aria-label="Server label" style={{ ...fieldInput, flex: '0 0 34%' }} />
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="https://host:3456" aria-label="Server address" style={{ ...fieldInput, flex: 1 }} />
          <button onClick={() => void add()} disabled={!canAdd} style={solidBtn(canAdd)}>Add</button>
        </div>
        {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
      </div>
    </>
  );
}
