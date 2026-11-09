import type { ConvItem } from '../../../api/types';
import { Markdown } from '../../Markdown';
import { fontVar } from '../../../lib/fontSize';

export function WebView({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  let input: any = {};
  try { input = JSON.parse(tool.toolInput ?? '{}'); } catch { /* empty */ }
  const url = typeof input.url === 'string' ? input.url : '';
  const query = typeof input.query === 'string' ? input.query : '';
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const out = result?.text ?? '';
  return (
    <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {url && <div style={{ font: `500 ${fontVar(12)} var(--font-mono)`, color: 'var(--color-accent)', wordBreak: 'break-all' }}>{url}</div>}
      {query && <div style={{ font: `500 ${fontVar(12.5)} var(--font-sans)`, color: 'var(--color-text-primary)' }}>{query}</div>}
      {prompt && <div style={{ fontSize: fontVar(12), color: 'var(--color-text-tertiary)' }}>{prompt}</div>}
      {out.trim() && <div style={{ fontSize: fontVar(12.5), color: 'var(--color-text-secondary)' }}><Markdown source={out} /></div>}
    </div>
  );
}
