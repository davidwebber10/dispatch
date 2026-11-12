import { useState } from 'react';
import { Modal } from '../common/Modal';
import { DirectoryPicker } from '../common/DirectoryPicker';
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { can } from '../../lib/profile';
import { isHosted } from '../../lib/hostContext';

/**
 * New Project. Local: a name and a folder (unchanged). A hosted workspace asks for a NAME only: the
 * workspace makes the project's folder itself (daemon side, ~/projects/<name>). A developer there
 * keeps the folder as an "Advanced" option; a business person never sees a path (lib/profile.ts
 * 'projects.path'). A create that the workspace refuses shows its reason here, never nothing.
 */
export function NewProjectModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const showPath = can('projects.path');
  const nameFirst = isHosted() || !showPath;

  async function create() {
    setError(null);
    if (!nameFirst && !dir.trim()) return;
    if (nameFirst && !name.trim() && !dir.trim()) { setError('Type a name for the project.'); return; }
    setBusy(true);
    try {
      await api.createSession({ provider: 'claude-code', name: name.trim() || undefined, ...(dir.trim() ? { workingDir: dir.trim() } : {}) });
      await useProjects.getState().load();
      onClose(); setName(''); setDir('');
    } catch (e) {
      if (!nameFirst) throw e;
      setError(e instanceof Error && e.message ? `Could not create the project: ${e.message}` : 'Could not create the project. Try again in a moment.');
    } finally { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 34, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 13 };
  const pathRow = (
    <div style={{ display: 'flex', gap: 8 }}>
      <input style={{ ...input, flex: 1 }} placeholder="/path/to/project" value={dir} onChange={(e) => setDir(e.target.value)} />
      <button type="button" onClick={() => setPicking(true)} style={{ height: 34, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', cursor: 'pointer' }}>Browse…</button>
    </div>
  );
  return (
    <Modal open={open} onClose={onClose} title="New Project">
      <input style={{ ...input, marginBottom: 10 }} placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" />
      {!nameFirst ? pathRow : showPath && (
        <div>
          <button type="button" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}
            style={{ background: 'none', border: 'none', padding: '2px 0', color: 'var(--color-text-secondary)', fontSize: 12.5, cursor: 'pointer' }}>
            {advanced ? '▾' : '▸'} Advanced: use an existing folder
          </button>
          {advanced && <div style={{ marginTop: 8 }}>{pathRow}</div>}
        </div>
      )}
      {error && <div role="alert" style={{ marginTop: 10, fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)' }}>Cancel</button>
        <button disabled={busy} onClick={create} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', fontWeight: 600 }}>Create Project</button>
      </div>
      {picking && <DirectoryPicker onSelect={(p) => { setDir(p); setPicking(false); }} onClose={() => setPicking(false)} />}
    </Modal>
  );
}
