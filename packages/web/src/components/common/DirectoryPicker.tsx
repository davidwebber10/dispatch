import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { api } from '../../api/client';
import type { FileEntry } from '../../api/types';

const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

export function DirectoryPicker({ onSelect, onClose }: { onSelect: (absPath: string) => void; onClose: () => void }) {
  const [arg, setArg] = useState('~');     // path requested from the server
  const [cwd, setCwd] = useState('~');     // resolved absolute dir (best-effort)
  const [dirs, setDirs] = useState<FileEntry[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    let on = true;
    api.browse(arg)
      .then((entries) => {
        if (!on) return;
        setDirs(entries.filter((e) => e.isDirectory));
        setCwd(entries.length ? parentOf(entries[0].path) : arg);
        setErr('');
      })
      .catch(() => { if (on) { setDirs([]); setErr('Cannot read this directory'); } });
    return () => { on = false; };
  }, [arg]);

  async function newFolder() {
    const name = window.prompt('New folder name');
    if (!name || !name.trim()) return;
    const target = `${cwd.replace(/\/$/, '')}/${name.trim()}`;
    try { await api.stateMkdir(target); setArg(target); } catch { setErr('Could not create folder'); }
  }

  const row: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', background: 'transparent', border: 'none', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13, borderRadius: 6 };

  return (
    <Modal open onClose={onClose} title="Choose project folder">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ flex: 1, font: '400 11px var(--font-mono)', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{cwd}</span>
        <button onClick={() => void newFolder()} style={{ height: 26, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}>+ New folder</button>
      </div>
      <div style={{ maxHeight: 300, overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, padding: 4 }}>
        <button onClick={() => setArg(parentOf(cwd))} style={{ ...row, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>↑ ..</button>
        {dirs.map((d) => (
          <button key={d.path} onClick={() => setArg(d.path)} style={row}>▸ {d.name}</button>
        ))}
        {!dirs.length && !err && <div style={{ padding: 8, color: 'var(--color-text-tertiary)', fontSize: 12.5 }}>No subfolders</div>}
        {err && <div style={{ padding: 8, color: 'var(--color-status-red)', fontSize: 12.5 }}>{err}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button onClick={onClose} style={{ height: 32, padding: '0 14px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)' }}>Cancel</button>
        <button onClick={() => onSelect(cwd)} style={{ height: 32, padding: '0 18px', background: 'var(--color-accent)', border: 'none', borderRadius: 8, color: '#08240F', fontWeight: 600 }}>Use this folder</button>
      </div>
    </Modal>
  );
}
