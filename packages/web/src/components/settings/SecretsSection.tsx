import { useEffect, useRef, useState } from 'react';
import { Key, Eye, EyeSlash, Copy, Check, Trash } from '@phosphor-icons/react';
import { useSecrets } from '../../stores/secrets';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pageLabel, summaryLine, ghostBtn, fieldInput, solidBtn, Toggle, SearchInput, HoverRow, IconGhost, Sheet } from './ui';

const desc: React.CSSProperties = { fontSize: 12.5, color: 'var(--color-text-secondary)' };
const mono: React.CSSProperties = { font: '400 11.5px var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const colHead: React.CSSProperties = { font: '600 9.5px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)' };
const grid = 'minmax(260px,1.25fr) minmax(150px,1fr) 92px';

export function SecretsSection() {
  const isMobile = useIsMobile();
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
  const [query, setQuery] = useState('');
  const [synced, setSynced] = useState(false);
  const [copied, setCopied] = useState('');
  const [sheet, setSheet] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => { void useSecrets.getState().loadStatus(); }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (status?.project) { setProject(status.project); void useSecrets.getState().loadConfigs(status.project); }
    if (status?.config) setConfig(status.config);
  }, [status?.project, status?.config]);

  const connected = !!status?.connected;
  const readOnly = !!status?.readOnly;
  const select: React.CSSProperties = { ...fieldInput, appearance: 'none', cursor: 'pointer' };
  const canAdd = !!newName.trim() && !!newValue.trim() && !readOnly && !busy;
  const filtered = query ? secrets.filter((s) => s.name.toLowerCase().includes(query.toLowerCase())) : secrets;
  const allShown = filtered.length > 0 && filtered.every((s) => reveal[s.name]);

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

  async function resync() {
    if (busy) return;
    setErr('');
    try {
      await useSecrets.getState().loadSecrets();
      setSynced(true);
      timers.current.push(setTimeout(() => setSynced(false), 1500));
    } catch { setErr('Could not re-sync.'); }
  }

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    try { await useSecrets.getState().setSecret(newName.trim(), newValue); setNewName(''); setNewValue(''); setSheet(false); }
    catch { setErr('Could not save secret.'); }
    setBusy(false);
  }

  async function remove(name: string) {
    setErr('');
    try { await useSecrets.getState().deleteSecret(name); } catch { setErr('Could not delete secret.'); }
  }

  function copyValue(name: string, value: string) {
    void navigator.clipboard?.writeText(value);
    setCopied(name);
    timers.current.push(setTimeout(() => setCopied((c) => (c === name ? '' : c)), 1200));
  }

  const actions = (name: string, value: string) => {
    const shown = !!reveal[name];
    return (
      <span style={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <IconGhost title={shown ? 'Hide value' : 'Reveal value'} active={shown} onClick={() => setReveal((r) => ({ ...r, [name]: !r[name] }))}>
          {shown ? <EyeSlash size={14} /> : <Eye size={14} />}
        </IconGhost>
        <IconGhost title="Copy value" active={copied === name} onClick={() => copyValue(name, value)}>
          {copied === name ? <Check size={14} /> : <Copy size={14} />}
        </IconGhost>
        {!readOnly && <IconGhost title="Delete secret" danger onClick={() => void remove(name)}><Trash size={14} /></IconGhost>}
      </span>
    );
  };

  const valueCell = (name: string, value: string) => (reveal[name]
    ? <span style={{ ...mono, color: 'var(--color-text-secondary)' }}>{value}</span>
    : <span style={{ color: 'var(--color-text-tertiary)', letterSpacing: '2px', fontSize: 10, overflow: 'hidden', whiteSpace: 'nowrap' }}>••••••••••••</span>);

  const addForm = (inSheet: boolean) => (
    <div style={{ display: 'flex', flexDirection: inSheet ? 'column' : 'row', gap: 8 }}>
      <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="NAME" style={{ ...fieldInput, flex: inSheet ? undefined : '0 1 330px', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }} />
      <input value={newValue} onChange={(e) => setNewValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder="value" style={{ ...fieldInput, flex: 1, fontFamily: 'var(--font-mono)' }} />
      {inSheet ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={() => void add()} disabled={!canAdd} style={{ ...solidBtn(canAdd), flex: 1 }}>{busy ? 'Adding…' : 'Add'}</button>
          <button onClick={() => setSheet(false)} style={{ ...ghostBtn, flex: 1 }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => void add()} disabled={!canAdd} style={solidBtn(canAdd)}>{busy ? 'Adding…' : 'Add'}</button>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Key size={13} weight="fill" color="var(--color-text-tertiary)" />
        <span style={pageLabel}>SECRETS (DOPPLER)</span>
        <span style={{ flex: 1 }} />
        {connected && (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, font: '500 11px var(--font-mono)', color: 'var(--color-accent)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-accent)' }} />
              {status?.project ?? '—'}{status?.config ? ` / ${status.config}` : ''}
            </span>
            <button onClick={() => void resync()} disabled={busy} style={{ ...ghostBtn, height: 26, padding: '0 10px', fontSize: 11.5, color: synced ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>{synced ? 'Synced ✓' : 'Re-sync'}</button>
            <button onClick={() => void disconnect()} disabled={busy} style={{ ...ghostBtn, height: 26, padding: '0 10px', fontSize: 11.5 }}>Disconnect</button>
          </>
        )}
      </div>
      <div style={desc}>Sync environment variables from Doppler into your sessions. Token stored on this daemon.</div>

      {!connected ? (
        <>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} placeholder="Doppler service token (dp.st.…)" autoComplete="off" style={fieldInput} />
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
            <button onClick={() => void connect()} disabled={!token.trim() || busy} style={solidBtn(!!token.trim() && !busy)}>Connect</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '9px 0', borderTop: '1px solid var(--color-hover)', borderBottom: '1px solid var(--color-hover)' }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span style={{ fontSize: 13, color: '#c9c9cf' }}>Read-only</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{readOnly ? 'Values come from Doppler; nothing on this daemon can change them.' : 'Edits allowed — changes write to Doppler.'}</span>
            </span>
            <Toggle on={readOnly} onClick={() => void toggleReadOnly()} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
            <SearchInput value={query} onChange={setQuery} placeholder="Filter variables" />
            <button onClick={() => setReveal(allShown ? {} : Object.fromEntries(filtered.map((s) => [s.name, true])))} style={{ ...ghostBtn, fontSize: 11.5 }}>
              {allShown ? 'Hide all values' : 'Reveal all values'}
            </button>
            {!isMobile && <span style={{ ...summaryLine, flexShrink: 0 }}>{secrets.length} variable{secrets.length === 1 ? '' : 's'}</span>}
          </div>

          {!isMobile && filtered.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, alignItems: 'center', padding: '4px 2px', borderBottom: '1px solid var(--color-hover)' }}>
              <span style={colHead}>NAME</span>
              <span style={colHead}>VALUE</span>
              <span />
            </div>
          )}
          {filtered.map((s) => (isMobile ? (
            <HoverRow key={s.name} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '9px 2px' }}>
              <span style={{ ...mono, color: '#e9e9ec' }}>{s.name}</span>
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                <span style={{ minWidth: 0, overflow: 'hidden' }}>{valueCell(s.name, s.value)}</span>
                {actions(s.name, s.value)}
              </span>
            </HoverRow>
          ) : (
            <HoverRow key={s.name} style={{ display: 'grid', gridTemplateColumns: grid, gap: 8, alignItems: 'center', padding: '7px 2px' }}>
              <span style={{ ...mono, color: '#e9e9ec' }}>{s.name}</span>
              {valueCell(s.name, s.value)}
              {actions(s.name, s.value)}
            </HoverRow>
          )))}
          {filtered.length === 0 && secrets.length > 0 && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)', textAlign: 'center', padding: '14px 0' }}>No variables match “{query}”</div>}
          {secrets.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--color-text-tertiary)' }}>No secrets in this config.</div>}

          {!readOnly && (isMobile ? (
            <>
              <button onClick={() => setSheet(true)} style={{ ...solidBtn(true), width: '100%', marginTop: 4 }}>Add variable</button>
              <Sheet open={sheet} onClose={() => setSheet(false)} title="ADD VARIABLE">{addForm(true)}</Sheet>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <span style={{ ...pageLabel, fontSize: 10, fontWeight: 600 }}>ADD VARIABLE</span>
              {addForm(false)}
            </div>
          ))}

          {readOnly && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4, padding: '9px 12px', borderRadius: 8, background: 'color-mix(in srgb, var(--color-accent) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)' }}>
              <span style={{ font: '600 10px var(--font-mono)', letterSpacing: '1px', color: 'var(--color-accent)', flexShrink: 0 }}>read-only</span>
              <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>Values sync from Doppler. Turn off read-only to add, edit, or delete variables.</span>
            </div>
          )}
        </>
      )}
      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
