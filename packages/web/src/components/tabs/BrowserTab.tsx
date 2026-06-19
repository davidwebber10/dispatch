import { useState } from 'react';
import type { Terminal } from '../../api/types';

export function BrowserTab({ terminal }: { terminal: Terminal }) {
  const initial = (terminal.config?.url as string) || 'about:blank';
  const [url, setUrl] = useState(initial);
  const [src, setSrc] = useState(initial);

  const field: React.CSSProperties = { flex: 1, height: 28, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-primary)', fontSize: 12.5, fontFamily: 'var(--font-mono)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSrc(url); }} style={field} />
        <a href={src} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', padding: '0 10px', height: 28, background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 7, color: 'var(--color-text-secondary)', fontSize: 12, textDecoration: 'none' }}>Open ↗</a>
      </div>
      {/* Many sites forbid being iframed (X-Frame-Options/CSP); the "Open ↗" link is the universal fallback. */}
      <iframe title="browser" src={src} style={{ flex: 1, border: 'none', background: '#fff' }} />
    </div>
  );
}
