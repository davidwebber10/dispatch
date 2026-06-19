import { useState } from 'react';
import { Modal } from '../common/Modal';
import { DirectoryPicker } from '../common/DirectoryPicker';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  async function create() {
    if (!dir.trim()) return;
    setBusy(true);
    try {
      await api.createSession({ provider: 'claude-code', name: name.trim() || undefined, workingDir: dir.trim() });
      await useProjects.getState().load();
      onClose(); setName(''); setDir('');
    } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 13 };
  return (
    <Modal open={open} onClose={onClose} title="New Project">
      <input style={{ ...input, marginBottom: 10 }} placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...input, flex: 1 }} placeholder="/path/to/project" value={dir} onChange={(e) => setDir(e.target.value)} />
        <button type="button" onClick={() => setPicking(true)} style={{ height: 34, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', whiteSpace: 'nowrap', cursor: 'pointer' }}>Browse…</button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)' }}>Cancel</button>
        <button disabled={busy} onClick={create} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600 }}>Create Project</button>
      </div>
      {picking && <DirectoryPicker onSelect={(p) => { setDir(p); setPicking(false); }} onClose={() => setPicking(false)} />}
    </Modal>
  );
}
