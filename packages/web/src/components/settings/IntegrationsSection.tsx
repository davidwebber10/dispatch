import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput, IntegrationsExport } from '../../api/types';

const label: React.CSSProperties = { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' };
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
const ghost: React.CSSProperties = { height: 30, padding: '0 12px', background: 'transparent', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, cursor: 'pointer' };
const addBtn = (on: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: on ? 'pointer' : 'default', opacity: on ? 1 : 0.5 });
const chip: React.CSSProperties = { font: '400 10px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' };

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

export function IntegrationsSection() {
  const [list, setList] = useState<Integration[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try { setList((await api.listIntegrations()).integrations); }
    catch { setErr('Could not reach Dispatch.'); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const canAdd = !busy && /^[a-zA-Z0-9_-]+$/.test(name.trim()) && (advanced ? !!command.trim() : /^https?:\/\//.test(url.trim()));

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    const inputData: AddIntegrationInput = advanced
      ? { type: 'stdio', name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean), env: parseKV(env) }
      : { type: 'remote', name: name.trim(), url: url.trim(), headers: parseKV(headers) };
    try {
      await api.addIntegration(inputData);
      setName(''); setUrl(''); setHeaders(''); setCommand(''); setArgs(''); setEnv('');
      await reload();
    } catch { setErr('Could not add — check the name is unique and the inputs are valid.'); }
    setBusy(false);
  }
  async function toggle(i: Integration) { if (busy) return; setBusy(true); setErr(''); try { await api.setIntegrationEnabled(i.id, !i.enabled); await reload(); } catch { setErr('Could not update.'); } setBusy(false); }
  async function remove(id: string) { if (busy) return; setBusy(true); setErr(''); try { await api.removeIntegration(id); await reload(); } catch { setErr('Could not remove.'); } setBusy(false); }

  async function doExport() {
    try {
      const doc = await api.exportIntegrations();
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'integrations.json'; a.click(); URL.revokeObjectURL(a.href);
    } catch { setErr('Export failed — could not reach Dispatch.'); }
  }
  async function doImport(file: File) {
    setErr('');
    try { const doc = JSON.parse(await file.text()) as IntegrationsExport; const r = await api.importIntegrations(doc); await reload(); setErr(`Imported ${r.added.length}, skipped ${r.skipped.length}.`); }
    catch { setErr('Import failed — invalid file.'); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={label}>INTEGRATIONS</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button style={ghost} onClick={() => void doExport()}>Export</button>
          <button style={ghost} onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
        </span>
      </div>
      <div style={sub}>MCP servers shared across Claude &amp; Codex. Secrets come from Doppler (servers inherit your session env).</div>

      {list.length === 0 && <div style={sub}>No integrations yet. Add one below.</div>}
      {list.map((i) => (
        <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: i.enabled ? 1 : 0.5 }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13, color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
              <span style={chip}>{i.type}</span>
            </span>
            <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.type === 'remote' ? i.url : `${i.command} ${i.args.join(' ')}`}</span>
          </span>
          <button title={i.enabled ? 'Disable' : 'Enable'} onClick={() => void toggle(i)} style={{ ...ghost, height: 26, padding: '0 9px' }}>{i.enabled ? 'On' : 'Off'}</button>
          <button title="Remove" onClick={() => void remove(i.id)} style={{ width: 26, height: 26, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
        </div>
      ))}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name — letters, digits, _ - (e.g. linear)" style={{ ...input, flex: '0 0 32%' }} />
          {!advanced && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" style={{ ...input, flex: 1 }} />}
          {advanced && <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" style={{ ...input, flex: 1 }} />}
          <button onClick={() => void add()} disabled={!canAdd} style={addBtn(canAdd)}>{busy ? 'Adding…' : 'Add'}</button>
        </div>
        {!advanced && <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="optional headers, one per line: Authorization=Bearer ${MY_TOKEN}" style={{ ...input, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />}
        {advanced && (
          <>
            <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args (space-separated, e.g. -y @scope/mcp-server)" style={input} />
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="optional env, one per line: ROOT=/tmp" style={{ ...input, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />
          </>
        )}
        <button onClick={() => setAdvanced((a) => !a)} style={{ ...ghost, alignSelf: 'flex-start', border: 'none', padding: '0 2px', color: 'var(--color-text-tertiary)' }}>{advanced ? '← back to URL' : 'Advanced: add a local command'}</button>
      </div>

      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
