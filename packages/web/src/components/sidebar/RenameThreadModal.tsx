import { useState } from 'react';
import { Modal } from '../common/Modal';
import { useTabs } from '../../stores/tabs';

export function RenameThreadModal({ terminalId, sessionId, current, onClose }: { terminalId: string; sessionId: string; current: string; onClose: () => void }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);

  async function save() {
    const v = name.trim();
    if (!v) { onClose(); return; }
    // Optimistic (W2-I): the label changes and the dialog closes at once. A failure puts the old label
    // back and shows a hint (stores/tabs.ts).
    setBusy(true);
    void useTabs.getState().rename(terminalId, v);
    onClose();
  }

  const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13 };
  return (
    <Modal open onClose={onClose} title="Rename Thread">
      <input autoFocus style={input} placeholder="Thread name" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: 'pointer' }}>Cancel</button>
        <button disabled={busy} onClick={() => void save()} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', fontWeight: 600, cursor: 'pointer' }}>Rename</button>
      </div>
    </Modal>
  );
}
