import type { ConvItem } from '../../../api/types';
import { highlightCode, langFromPath } from '../../../lib/markdown';
import { lineDiff, type DiffLine } from './diff';

function Hunk({ lines }: { lines: DiffLine[] }) {
  const bg = (t: DiffLine['type']) => t === 'add' ? 'rgba(63,185,80,.14)' : t === 'del' ? 'rgba(240,97,109,.14)' : 'transparent';
  const fg = (t: DiffLine['type']) => t === 'add' ? '#5fce7e' : t === 'del' ? '#f0616d' : 'var(--color-text-secondary)';
  const sign = (t: DiffLine['type']) => t === 'add' ? '+' : t === 'del' ? '-' : ' ';
  return (
    <pre style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, overflow: 'auto', maxHeight: 360 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ background: bg(l.type), color: fg(l.type), padding: '0 11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <span style={{ opacity: 0.6, userSelect: 'none' }}>{sign(l.type)} </span>{l.text}
        </div>
      ))}
    </pre>
  );
}

export function DiffView({ tool }: { tool: ConvItem }) {
  let input: any = {};
  try { input = JSON.parse(tool.toolInput ?? '{}'); } catch { /* raw fallback below */ }

  if (tool.toolName === 'Write') {
    const content = String(input.content ?? '');
    return (
      <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <code dangerouslySetInnerHTML={{ __html: highlightCode(content, langFromPath(tool.toolFile)) }} />
      </pre>
    );
  }

  const edits: Array<{ old_string?: string; new_string?: string }> =
    tool.toolName === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

  return (
    <div>
      {edits.map((e, i) => (
        <div key={i} style={{ borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
          <Hunk lines={lineDiff(String(e.old_string ?? ''), String(e.new_string ?? ''))} />
        </div>
      ))}
    </div>
  );
}
