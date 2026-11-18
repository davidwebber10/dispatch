import { useState } from 'react';
import { HardDrives, Trash } from '@phosphor-icons/react';
import { useConnection } from '../../stores/connection';
import { useServers, currentLabel, type ServerOption } from '../../stores/servers';
import { useIsMobile } from '../../hooks/useIsMobile';
import { ConfirmModal } from '../common/ConfirmModal';
import { SettingsPage, SettingsGroup, SettingsRow, StatusMark, EmptyState, Sheet, fieldFor, CONNECTION_STATUS, type Tone } from './ui';
import { Button, IconButton } from '../ui';
import { fontVar } from '../../lib/fontSize';

/** This browser's link to the daemon, as a status tone (the words come from ui CONNECTION_STATUS). */
const CONNECTION_TONE: Record<'open' | 'connecting' | 'closed', { tone: Tone; label: string }> = {
  open: { tone: 'accent', label: CONNECTION_STATUS.open.label },
  connecting: { tone: 'yellow', label: CONNECTION_STATUS.connecting.label },
  closed: { tone: 'red', label: CONNECTION_STATUS.closed.label },
};

/**
 * Settings → Servers: this device's connection, and the other Dispatch machines it knows about
 * (switch between them from the brand menu; the list is kept on the daemon, so every device sees it).
 *
 * 2026-11-07 (docs/design/settings-layout.md): a "This device" status group on both shells (the
 * desktop nav's DAEMON block is gone), a "Servers" group of list rows with removal behind a
 * confirm, and the add form in a sheet.
 */
export function ServersSection() {
  const status = useConnection((s) => s.status);
  const servers = useServers((s) => s.servers);
  const isMobile = useIsMobile();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ServerOption | null>(null);
  const conn = CONNECTION_TONE[status];

  const addButton = <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>Add server…</Button>;

  return (
    <SettingsPage>
      <SettingsGroup title="This device">
        <SettingsRow label="Connection" control={<span data-testid="connection-status"><StatusMark tone={conn.tone}>{conn.label}</StatusMark></span>} />
        <SettingsRow label="Server" hint="The Dispatch this page is talking to." value={currentLabel(servers)} />
      </SettingsGroup>

      {servers.length === 0 ? (
        <section role="group" aria-label="Servers" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <EmptyState action={addButton}>No other servers yet. Add one to switch to it from the brand menu.</EmptyState>
        </section>
      ) : (
        <SettingsGroup title="Servers" action={addButton} footer="Switch servers from the brand menu. Every device sees this list.">
          {servers.map((s) => (
            <SettingsRow key={s.origin} icon={HardDrives} label={s.label}
              hint={<span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: fontVar(11.5), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.origin}</span>}
              control={(
                <IconButton label={`Remove ${s.label}`} title="Remove server" icon={<Trash size={16} />} onClick={() => setRemoving(s)}
                  style={{ width: 30, height: 30, borderRadius: 'var(--radius-sm)', color: 'var(--color-text-tertiary)' }} />
              )} />
          ))}
        </SettingsGroup>
      )}

      <AddServerSheet open={adding} onClose={() => setAdding(false)} phone={isMobile} />

      <ConfirmModal open={removing !== null} danger title={`Remove ${removing?.label ?? 'this server'}?`} confirmLabel="Remove server"
        message="It leaves the brand menu on every device. The machine and its threads stay as they are, and you can add it again."
        onCancel={() => setRemoving(null)}
        onConfirm={() => { const s = removing; setRemoving(null); if (s) void useServers.getState().remove(s.origin); }} />
    </SettingsPage>
  );
}

/** The "Add server" form: a label and an address, in the shared slide-up sheet. */
function AddServerSheet({ open, onClose, phone }: { open: boolean; onClose: () => void; phone: boolean }) {
  const [label, setLabel] = useState('');
  const [origin, setOrigin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const canAdd = !!label.trim() && !!origin.trim() && !busy;
  const field = { ...fieldFor(phone), width: '100%' };
  const fieldLabel: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, fontSize: fontVar(12), color: 'var(--color-text-secondary)' };

  const close = () => { setLabel(''); setOrigin(''); setErr(''); onClose(); };
  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useServers.getState().add(label.trim(), origin.trim()); setBusy(false); close(); }
    catch { setErr('Could not add. The address must be an http(s) URL.'); setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={close} title="Add server">
      <div style={{ fontSize: fontVar(12.5), lineHeight: 1.5, color: 'var(--color-text-tertiary)' }}>Another machine that runs Dispatch. You can switch to it from the brand menu.</div>
      <label style={fieldLabel}>
        Name
        <input aria-label="Server label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Mac mini" style={field} />
      </label>
      <label style={fieldLabel}>
        Address
        <input aria-label="Server address" value={origin} onChange={(e) => setOrigin(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder="https://host:3456" spellCheck={false} autoCapitalize="off" style={{ ...field, fontFamily: 'var(--font-mono)' }} />
      </label>
      {err && <div role="alert" style={{ fontSize: fontVar(12), color: 'var(--color-status-red)' }}>{err}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
        <Button variant="ghost" size="sm" onClick={close}>Cancel</Button>
        <Button onClick={() => void add()} disabled={!canAdd} variant="primary" size="sm">Add server</Button>
      </div>
    </Sheet>
  );
}
