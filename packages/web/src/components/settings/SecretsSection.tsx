import { useEffect, useState } from 'react';
import { Key, Eye, EyeSlash, Plus, Trash } from '@phosphor-icons/react';
import { useSecrets } from '../../stores/secrets';
import { sectionLabel, row, item, iconBtn, Toggle } from './ui';

export function SecretsSection() {
  const status = useSecrets((s) => s.status);
  const secrets = useSecrets((s) => s.secrets);
  const projects = useSecrets((s) => s.projects);
  const configs = useSecrets((s) => s.configs);

  const [token, setToken] = useState('');
  const [project, setProject] = useState('');
  const [config, setConfig] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [reveal, setReveal] = useState<Record<string, boolean>>({});

  useEffect(() => { void useSecrets.getState().loadStatus(); }, []);
  useEffect(() => {
    if (status?.project) { setProject(status.project); void useSecrets.getState().loadConfigs(status.project); }
    if (status?.config) setConfig(status.config);
  }, [status?.project, status?.config]);

  const connected = !!status?.connected;
  const readOnly = !!status?.readOnly;
  const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
  const select: React.CSSProperties = { ...input, appearance: 'none', cursor: 'pointer' };
  const canAdd = !!newName.trim() && !!newValue.trim() && !readOnly && !busy;

  async function connect() {
    if (!token.trim() || busy) return;
    setBusy(true); setErr('');
    try {
      await useSecrets.getState().connect({ token: token.trim(), project, config, enabled: true, readOnly });
      await useSecrets.getState().loadProjects();
    } catch { setErr('Could not connect — check your Doppler token.'); }
    setBusy(false);
  }

  async function pickProject(p: string) {
    setProject(p); setConfig('');
    try { await useSecrets.getState().loadConfigs(p); } catch { setErr('Could not load configs.'); }
  }

  async function pickConfig(c: string) {
    setConfig(c);
    if (!token.trim()) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().connect({ token: token.trim(), project, config: c, enabled: true, readOnly }); }
    catch { setErr('Could not save selection.'); }
    setBusy(false);
  }

  async function toggleReadOnly() {
    if (!status) return;
    setBusy(true); setErr('');
    // token left blank: daemon keeps the stored token, updates only flags.
    try { await useSecrets.getState().connect({ token: '', project: status.project ?? '', config: status.config ?? '', enabled: status.enabled, readOnly: !readOnly }); }
    catch { setErr('Could not update read-only.'); }
    setBusy(false);
  }

  async function disconnect() {
    setBusy(true); setErr('');
    try { await useSecrets.getState().disconnect(); setToken(''); setProject(''); setConfig(''); }
    catch { setErr('Could not disconnect.'); }
    setBusy(false);
  }

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().setSecret(newName.trim(), newValue); setNewName(''); setNewValue(''); }
    catch { setErr('Could not save secret.'); }
    setBusy(false);
  }

  async function remove(name: string) {
    setErr('');
    try { await useSecrets.getState().deleteSecret(name); } catch { setErr('Could not delete secret.'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Key size={13} weight="fill" color="var(--color-text-tertiary)" />
        <span style={sectionLabel}>SECRETS (DOPPLER)</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>Sync environment variables from Doppler into your sessions. Token stored on this daemon.</div>

      {!connected ? (
        <>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} placeholder="Doppler service token (dp.st.…)" autoComplete="off" style={input} />
          <div style={{ display: 'flex', gap: 8 }}>
            {projects.length > 0 && (
              <select value={project} onChange={(e) => void pickProject(e.target.value)} style={{ ...select, flex: 1 }}>
                <option value="">Select project…</option>
                {projects.map((p) => <option key={p.id} value={p.slug}>{p.name}</option>)}
              </select>
            )}
            {configs.length > 0 && (
              <select value={config} onChange={(e) => void pickConfig(e.target.value)} style={{ ...select, flex: 1 }}>
                <option value="">Select config…</option>
                {configs.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            )}
            <button onClick={() => void connect()} disabled={!token.trim() || busy} style={{ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: token.trim() && !busy ? 'pointer' : 'default', opacity: token.trim() && !busy ? 1 : 0.5 }}>Connect</button>
          </div>
        </>
      ) : (
        <>
          <div style={row}>
            <span style={item}>Connection</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: '500 11px var(--font-mono)', color: 'var(--color-accent)' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)' }} />
                {status?.project ?? '—'}{status?.config ? ` / ${status.config}` : ''}
              </span>
              <button onClick={() => void disconnect()} disabled={busy} style={{ height: 26, padding: '0 10px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', fontSize: 11.5, cursor: busy ? 'default' : 'pointer' }}>Disconnect</button>
            </span>
          </div>

          <div style={row}><span style={item}>Read-only</span><Toggle on={readOnly} onClick={() => void toggleReadOnly()} /></div>

          {secrets.map((s) => {
            const shown = !!reveal[s.name];
            return (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: '0 0 40%', minWidth: 0, font: '400 11.5px var(--font-mono)', color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <span style={{ flex: 1, minWidth: 0, font: '400 11.5px var(--font-mono)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown ? s.value : '••••••••••••'}</span>
                <button title={shown ? 'Hide value' : 'Reveal value'} onClick={() => setReveal((r) => ({ ...r, [s.name]: !r[s.name] }))} style={iconBtn}>
                  {shown ? <EyeSlash size={14} /> : <Eye size={14} />}
                </button>
                {!readOnly && (
                  <button title="Delete secret" onClick={() => void remove(s.name)} style={iconBtn}><Trash size={14} /></button>
                )}
              </div>
            );
          })}
          {secrets.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No secrets in this config.</div>}

          {!readOnly && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="NAME" style={{ ...input, flex: '0 0 40%', fontFamily: 'var(--font-mono)' }} />
              <input value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="value" style={{ ...input, flex: 1, fontFamily: 'var(--font-mono)' }} />
              <button title="Add secret" onClick={() => void add()} disabled={!canAdd} style={{ ...iconBtn, width: 30, height: 30, background: 'var(--color-accent)', border: 'none', color: '#08240F', cursor: canAdd ? 'pointer' : 'default', opacity: canAdd ? 1 : 0.5 }}><Plus size={15} weight="bold" /></button>
            </div>
          )}
        </>
      )}
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
