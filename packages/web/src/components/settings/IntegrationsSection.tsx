import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput, IntegrationsExport } from '../../api/types';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pageLabel, summaryLine, ghostBtn, miniChip, fieldInput, solidBtn, GroupHeader, HoverRow, FilterSegments, Sheet, Divider } from './ui';

const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const desc: React.CSSProperties = { fontSize: 12.5, color: 'var(--color-text-secondary)' };
const onBtn = (on: boolean): React.CSSProperties => ({
  flexShrink: 0, height: 26, padding: '0 10px', borderRadius: 6, font: '500 11px var(--font-mono)', cursor: 'pointer',
  background: on ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)' : 'transparent',
  border: on ? '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)' : '1px solid #2c2c32',
  color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)',
});

function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

export function IntegrationsSection() {
  const isMobile = useIsMobile();
  const [list, setList] = useState<Integration[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
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
  const active = list.filter((i) => i.enabled);
  const off = list.filter((i) => !i.enabled);

  async function add() {
    if (!canAdd) return;
    setBusy(true); setErr('');
    const inputData: AddIntegrationInput = advanced
      ? { type: 'stdio', name: name.trim(), command: command.trim(), args: args.split(' ').filter(Boolean), env: parseKV(env) }
      : { type: 'remote', name: name.trim(), url: url.trim(), headers: parseKV(headers) };
    try {
      await api.addIntegration(inputData);
      setName(''); setUrl(''); setHeaders(''); setCommand(''); setArgs(''); setEnv('');
      setSheet(false);
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

  const renderRow = (i: Integration) => (
    <HoverRow key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 2px' }}>
      {isMobile && <span style={{ width: 6, height: 6, flexShrink: 0, borderRadius: '50%', background: i.enabled ? 'var(--color-accent)' : '#4a4a52' }} />}
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 2 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: 13, fontWeight: 500, color: i.enabled ? '#e9e9ec' : 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
          <span style={miniChip}>{i.type === 'remote' ? 'REMOTE' : 'LOCAL'}</span>
        </span>
        <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.type === 'remote' ? i.url : `${i.command} ${i.args.join(' ')}`}</span>
      </span>
      <button title={i.enabled ? 'Disable' : 'Enable'} onClick={() => void toggle(i)} style={onBtn(i.enabled)}>{i.enabled ? 'On' : 'Off'}</button>
      <button title="Remove" onClick={() => void remove(i.id)}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-status-red)'; e.currentTarget.style.borderColor = 'color-mix(in srgb, var(--color-status-red) 45%, transparent)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; e.currentTarget.style.borderColor = '#2c2c32'; }}
        style={{ width: 26, height: 26, padding: 0, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
    </HoverRow>
  );

  const addForm = (inSheet: boolean) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {inSheet && (
        <FilterSegments active={advanced ? 'local' : 'remote'} onSelect={(k) => setAdvanced(k === 'local')}
          options={[{ key: 'remote', label: 'Remote' }, { key: 'local', label: 'Local command' }]} />
      )}
      <div style={{ display: 'flex', flexDirection: inSheet ? 'column' : 'row', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name — letters, digits, _ - (e.g. linear)" style={{ ...fieldInput, flex: inSheet ? undefined : '0 1 300px' }} />
        {!advanced && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" style={{ ...fieldInput, flex: inSheet ? undefined : 1 }} />}
        {advanced && <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command (e.g. npx)" style={{ ...fieldInput, flex: inSheet ? undefined : 1 }} />}
        {!inSheet && <button onClick={() => void add()} disabled={!canAdd} style={solidBtn(canAdd)}>{busy ? 'Adding…' : 'Add'}</button>}
      </div>
      {advanced && <input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="args (space-separated, e.g. -y @scope/mcp-server)" style={fieldInput} />}
      {!advanced && <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="optional headers, one per line: Authorization=Bearer ${MY_TOKEN}" style={{ ...fieldInput, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />}
      {advanced && <textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="optional env, one per line: ROOT=/tmp" style={{ ...fieldInput, height: 'auto', minHeight: 30, padding: '7px 9px', fontFamily: 'var(--font-mono)', fontSize: 11 }} rows={2} />}
      {inSheet ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
          <button onClick={() => void add()} disabled={!canAdd} style={{ ...solidBtn(canAdd), flex: 1 }}>{busy ? 'Adding…' : 'Add'}</button>
          <button onClick={() => setSheet(false)} style={{ ...ghostBtn, flex: 1 }}>Cancel</button>
        </div>
      ) : (
        <button onClick={() => setAdvanced((a) => !a)} style={{ ...ghostBtn, alignSelf: 'flex-start', border: 'none', padding: '0 2px', color: 'var(--color-text-tertiary)' }}>{advanced ? '← back to URL' : 'Advanced: add a local command'}</button>
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={pageLabel}>INTEGRATIONS</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button style={ghostBtn} onClick={() => void doExport()}>Export</button>
          <button style={ghostBtn} onClick={() => fileRef.current?.click()}>Import</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void doImport(f); e.target.value = ''; }} />
        </span>
      </div>
      <div style={desc}>MCP servers shared across Claude &amp; Codex. Secrets come from Doppler (servers inherit your session env).</div>
      <div style={summaryLine}>{list.length} server{list.length === 1 ? '' : 's'} · {active.length} on</div>

      {list.length === 0 && <div style={sub}>No integrations yet. Add one below.</div>}
      {active.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <GroupHeader label="ACTIVE" count={active.length} tone="accent" />
          {active.map(renderRow)}
        </div>
      )}
      {off.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <GroupHeader label="OFF" count={off.length} />
          {off.map(renderRow)}
        </div>
      )}

      {isMobile ? (
        <>
          <button onClick={() => setSheet(true)} style={{ ...solidBtn(true), width: '100%', marginTop: 4 }}>Add server</button>
          <Sheet open={sheet} onClose={() => setSheet(false)} title="ADD A SERVER">{addForm(true)}</Sheet>
        </>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <Divider />
          <span style={{ ...pageLabel, fontSize: 10, fontWeight: 600 }}>ADD A SERVER</span>
          {addForm(false)}
        </div>
      )}

      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
