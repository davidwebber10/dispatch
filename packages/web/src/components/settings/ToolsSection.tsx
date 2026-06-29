import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import type { ToolStatus } from '../../api/types';

const chip: React.CSSProperties = { fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-tertiary)', border: '1px solid #2c2c32', borderRadius: 5, padding: '1px 6px' };
const sub: React.CSSProperties = { fontSize: 12, color: 'var(--color-text-tertiary)' };

export function ToolsSection() {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { (async () => {
    try { setTools((await api.getTools()).tools); } catch { setErr('Could not reach Dispatch.'); }
  })(); }, []);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }}>
        CLIs bundled with Dispatch and available to the agent in every thread. Add your own in <code>~/.dispatch/tools.json</code>, then run <code>dispatch tools install</code>.
      </div>
      {err && <div style={{ color: 'var(--color-status-red)', fontSize: 12 }}>{err}</div>}
      {tools.map((t) => (
        <div key={t.name} style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: t.installed ? 1 : 0.5 }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 13, color: '#e9e9ec' }}>{t.name}</span>
              <span style={chip}>{t.kind}</span>
            </span>
            <span style={{ ...sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</span>
          </span>
          {t.docs && <a href={t.docs} target="_blank" rel="noreferrer" style={{ ...sub, color: 'var(--color-accent)' }}>docs</a>}
          <span style={{ fontSize: 11, color: t.installed ? 'var(--color-status-green, #5fce7e)' : 'var(--color-text-tertiary)' }}>{t.installed ? 'installed' : 'not installed'}</span>
          <span style={{ fontSize: 11, color: t.authed ? 'var(--color-text-tertiary)' : 'var(--color-status-yellow)' }}>{t.authed ? 'authed' : 'needs auth'}</span>
        </div>
      ))}
    </div>
  );
}
