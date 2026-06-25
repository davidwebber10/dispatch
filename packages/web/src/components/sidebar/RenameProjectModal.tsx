import { useState } from 'react';
import { Modal } from '../common/Modal';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';

export function RenameProjectModal({ sessionId, current, onClose }: { sessionId: string; current: string; onClose: () => void }) {
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);

  async function save() {
    const v = name.trim();
    if (!v) { onClose(); return; }
    setBusy(true);
    try {
      await api.updateSession(sessionId, { name: v });
      await useProjects.getState().load();
      onClose();
    } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13 };
  return (
    <Modal open onClose={onClose} title="Rename Project">
      <input autoFocus style={input} placeholder="Project name" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', cursor: 'pointer' }}>Cancel</button>
        <button disabled={busy} onClick={() => void save()} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600, cursor: 'pointer' }}>Rename</button>
      </div>
    </Modal>
  );
}
