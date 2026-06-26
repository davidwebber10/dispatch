import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { Integration, AddIntegrationInput } from '../../api/types';

type AddType = 'openapi' | 'mcp-stdio' | 'mcp-remote' | 'graphql';

const sectionLabel: React.CSSProperties = { font: '700 11px var(--font-mono)', letterSpacing: '1.3px', color: 'var(--color-text-secondary)' };
const sub: React.CSSProperties = { fontSize: 11.5, color: 'var(--color-text-tertiary)' };
const input: React.CSSProperties = { minWidth: 0, height: 30, padding: '0 9px', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 7, color: 'var(--color-text-primary)', font: '400 12px var(--font-sans)' };
const select: React.CSSProperties = { ...input, appearance: 'none', cursor: 'pointer' };
const addBtn = (enabled: boolean): React.CSSProperties => ({ flexShrink: 0, height: 30, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 7, color: '#08240F', fontWeight: 600, fontSize: 12.5, cursor: enabled ? 'pointer' : 'default', opacity: enabled ? 1 : 0.5 });
const kindChip: React.CSSProperties = { font: '400 10px var(--font-mono)', color: '#c9c9cf', background: '#1b1b1e', border: '1px solid #2c2c32', borderRadius: 5, padding: '2px 6px', textTransform: 'uppercase', letterSpacing: '0.5px' };

function buildInput(type: AddType, f: Record<string, string>): AddIntegrationInput | null {
  const t = (k: string) => (f[k] ?? '').trim();
  if (type === 'openapi') return t('url') && t('slug') ? { type, url: t('url'), slug: t('slug') } : null;
  if (type === 'mcp-stdio') return t('name') && t('command') ? { type, name: t('name'), command: t('command'), args: t('args').split(' ').filter(Boolean), ...(t('slug') ? { slug: t('slug') } : {}) } : null;
  if (type === 'mcp-remote') return t('name') && t('endpoint') ? { type, name: t('name'), endpoint: t('endpoint'), ...(t('slug') ? { slug: t('slug') } : {}) } : null;
  if (type === 'graphql') return t('endpoint') && t('slug') ? { type, endpoint: t('endpoint'), slug: t('slug') } : null;
  return null;
}

export function IntegrationsSection() {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [list, setList] = useState<Integration[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [removingSlug, setRemovingSlug] = useState<string | null>(null);
  const [type, setType] = useState<AddType>('mcp-stdio');
  const [fields, setFields] = useState<Record<string, string>>({});
  const setF = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  const reload = useCallback(async () => {
    setErr('');
    let st: { installed: boolean; version: string | null };
    try {
      st = await api.getIntegrationsStatus();
    } catch {
      setInstalled(false);
      setErr('Could not reach Dispatch. Check your connection and try again.');
      return;
    }
    setInstalled(st.installed);
    setVersion(st.version);
    if (!st.installed) { setList([]); return; }
    try {
      const r = await api.listIntegrations();
      setList(r.integrations);
    } catch {
      setErr('Could not reach the executor daemon. It starts on first use — try again in a moment.');
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  async function add() {
    const built = buildInput(type, fields);
    if (!built) { setErr('Fill in the required fields.'); return; }
    setBusy(true); setErr('');
    try { await api.addIntegration(built); setFields({}); await reload(); }
    catch { setErr('Could not add — check the inputs and that executor is reachable.'); }
    setBusy(false);
  }
  async function remove(slug: string) {
    if (removingSlug) return;
    setRemovingSlug(slug); setErr('');
    try { await api.removeIntegration(slug); await reload(); }
    catch { setErr('Could not remove.'); }
    setRemovingSlug(null);
  }

  const canAdd = !busy && !!buildInput(type, fields);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={sectionLabel}>INTEGRATIONS</span>
      <div style={sub}>One catalog shared across Claude &amp; Codex, via executor.</div>

      {installed === null && <div style={sub}>Checking…</div>}

      {installed === false && (
        <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
          executor not installed. Install with: <code>npm i -g executor</code> — then restart the daemon and it&apos;s shared across Claude &amp; Codex.
        </div>
      )}

      {installed === true && (
        <>
          <div style={{ ...sub, color: 'var(--color-text-secondary)' }}>executor {version ?? '(unknown version)'} — connected.</div>

          {list.length === 0 && <div style={sub}>No integrations yet. Add one below.</div>}
          {list.map((i) => (
            <div key={i.slug} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 13, color: '#e9e9ec', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.slug}</span>
                  <span style={kindChip}>{i.kind}</span>
                </span>
                {i.description && <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.description}</span>}
              </span>
              {i.canRemove && (
                <button title="Remove integration" disabled={removingSlug === i.slug} onClick={() => void remove(i.slug)} style={{ width: 26, height: 26, flexShrink: 0, background: 'transparent', border: '1px solid #2c2c32', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: removingSlug === i.slug ? 'default' : 'pointer', opacity: removingSlug === i.slug ? 0.5 : 1, fontSize: 15, lineHeight: 1 }}>×</button>
              )}
            </div>
          ))}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <select value={type} onChange={(e) => { setType(e.target.value as AddType); setFields({}); }} style={select}>
              <option value="mcp-stdio">Add MCP server (command)</option>
              <option value="mcp-remote">Add MCP server (remote URL)</option>
              <option value="openapi">Add OpenAPI / REST (URL)</option>
              <option value="graphql">Add GraphQL endpoint</option>
            </select>

            {type === 'openapi' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.url ?? ''} onChange={(e) => setF('url', e.target.value)} placeholder="OpenAPI spec URL" style={{ ...input, flex: 1 }} />
                <input value={fields.slug ?? ''} onChange={(e) => setF('slug', e.target.value)} placeholder="slug" style={{ ...input, flex: '0 0 28%' }} />
              </div>
            )}
            {type === 'mcp-stdio' && (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={fields.name ?? ''} onChange={(e) => setF('name', e.target.value)} placeholder="Name" style={{ ...input, flex: '0 0 38%' }} />
                  <input value={fields.command ?? ''} onChange={(e) => setF('command', e.target.value)} placeholder="command (must speak MCP, e.g. npx)" style={{ ...input, flex: 1 }} />
                </div>
                <input value={fields.args ?? ''} onChange={(e) => setF('args', e.target.value)} placeholder="args (space-separated, e.g. -y @scope/mcp-server)" style={input} />
              </>
            )}
            {type === 'mcp-remote' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.name ?? ''} onChange={(e) => setF('name', e.target.value)} placeholder="Name" style={{ ...input, flex: '0 0 38%' }} />
                <input value={fields.endpoint ?? ''} onChange={(e) => setF('endpoint', e.target.value)} placeholder="https://host/mcp" style={{ ...input, flex: 1 }} />
              </div>
            )}
            {type === 'graphql' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={fields.endpoint ?? ''} onChange={(e) => setF('endpoint', e.target.value)} placeholder="GraphQL endpoint URL" style={{ ...input, flex: 1 }} />
                <input value={fields.slug ?? ''} onChange={(e) => setF('slug', e.target.value)} placeholder="slug" style={{ ...input, flex: '0 0 28%' }} />
              </div>
            )}

            <button onClick={() => void add()} disabled={!canAdd} style={addBtn(canAdd)}>{busy ? 'Adding…' : 'Add integration'}</button>
          </div>
        </>
      )}

      {err && <div style={{ fontSize: 11.5, color: 'var(--color-status-red)' }}>{err}</div>}
    </div>
  );
}
