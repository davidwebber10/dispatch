import { useState } from 'react';
import { Modal } from '../common/Modal';
import { DirectoryPicker } from '../common/DirectoryPicker';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { BASE } from '../../lib/basePath';

/** A hosted box (served under a base path) makes a project from a name alone: ~/projects/<name> (core sessions/project-dir.ts). */
const NAME_ONLY = BASE !== '';

export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    // Local: a folder is required (as before). Hosted: a name is enough; a folder is optional.
    if (!dir.trim() && !(NAME_ONLY && name.trim())) {
      setError(NAME_ONLY ? 'Give the project a name.' : 'Choose a folder for the project.');
      return;
    }
    setBusy(true); setError(null);
    try {
      await api.createSession({ provider: 'claude-code', name: name.trim() || undefined, workingDir: dir.trim() });
      await useProjects.getState().load();
      onClose(); setName(''); setDir('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13 };
  return (
    <Modal open={open} onClose={onClose} title="New Project">
      <input style={{ ...input, marginBottom: 10 }} placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...input, flex: 1 }} placeholder={NAME_ONLY ? 'Folder (optional)' : '/path/to/project'} value={dir} onChange={(e) => setDir(e.target.value)} />
        <button type="button" onClick={() => setPicking(true)} style={{ height: 34, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', cursor: 'pointer' }}>Browse…</button>
      </div>
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' }}>Cancel</button>
        <button disabled={busy} onClick={create} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', fontWeight: 600 }}>Create Project</button>
      </div>
      {picking && <DirectoryPicker onSelect={(p) => { setDir(p); setPicking(false); }} onClose={() => setPicking(false)} />}
    </Modal>
  );
}
