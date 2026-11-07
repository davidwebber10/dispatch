import { useState } from 'react';
import type { Terminal } from '../../api/types';
import { isFrameableUrl } from '../../lib/safeUrl';

export function BrowserTab({ terminal }: { terminal: Terminal }) {
  const initial = (terminal.config?.url as string) || 'about:blank';
  const [url, setUrl] = useState(initial);
  const [src, setSrc] = useState(initial);
  // The address is stored text (an agent can set it). A javascript:, data: or vbscript: address would run
  // script on the app's origin, so only http(s) and about:blank reach the iframe and the Open link.
  const safeSrc = isFrameableUrl(src) ? src : 'about:blank';

  const field: React.CSSProperties = { flex: 1, height: 28, padding: '0 10px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', fontSize: 12.5, fontFamily: 'var(--font-mono)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setSrc(url); }} style={field} />
        <a href={safeSrc} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', padding: '0 10px', height: 28, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)', fontSize: 12, textDecoration: 'none' }}>Open ↗</a>
      </div>
      {/* Many sites forbid being iframed (X-Frame-Options/CSP); the "Open ↗" link is the universal fallback. */}
      {/* literal color: a web page expects a white page behind it (content, not chrome) */}
      <iframe title="browser" src={safeSrc} style={{ flex: 1, border: 'none', background: '#fff' }} />
    </div>
  );
}
