import type { ConvItem } from '../../../api/types';
import { renderMarkdown } from '../../../lib/markdown';

export function WebView({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  let input: any = {};
  try { input = JSON.parse(tool.toolInput ?? '{}'); } catch { /* empty */ }
  const url = typeof input.url === 'string' ? input.url : '';
  const query = typeof input.query === 'string' ? input.query : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const out = result?.text ?? '';
  return (
    <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {url && <div style={{ font: '500 12px var(--font-mono)', color: 'var(--color-accent)', wordBreak: 'break-all' }}>{url}</div>}
      {query && <div style={{ font: '500 12.5px var(--font-sans)', color: 'var(--color-text-primary)' }}>{query}</div>}
      {prompt && <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{prompt}</div>}
      {out.trim() && <div className="md-view" style={{ fontSize: 12.5, color: 'var(--color-text-secondary)' }} dangerouslySetInnerHTML={{ __html: renderMarkdown(out) }} />}
    </div>
  );
}
