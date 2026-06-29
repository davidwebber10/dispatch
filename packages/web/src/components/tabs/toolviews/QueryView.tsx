import type { ConvItem } from '../../../api/types';
import { highlightCode } from '../../../lib/markdown';
import { parseTable } from './tableParse';

const MAX_ROWS = 200;

function queryText(tool: ConvItem): string {
  try {
    const v = JSON.parse(tool.toolInput ?? '{}');
    return String(v.query ?? v.sql ?? v.statement ?? '');
  } catch { return ''; }
}

export function QueryView({ tool, result }: { tool: ConvItem; result?: ConvItem }) {
  const sql = queryText(tool);
  const out = result?.text ?? '';
  const table = out.trim() ? parseTable(out) : null;
  return (
    <div>
      {sql && (
        <pre className="hljs" style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', borderBottom: out ? '1px solid var(--color-border)' : 'none', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <code dangerouslySetInnerHTML={{ __html: highlightCode(sql, 'sql') }} />
        </pre>
      )}
      {result && (table
        ? <ResultTable columns={table.columns} rows={table.rows} />
        : (out.trim()
          ? <pre style={{ margin: 0, font: '400 11.5px var(--font-mono)', lineHeight: 1.5, padding: '9px 11px', maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: result.isError ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>{out}</pre>
          : null))}
    </div>
  );
}

function ResultTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const shown = rows.slice(0, MAX_ROWS);
  const th: React.CSSProperties = { textAlign: 'left', padding: '5px 9px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', fontWeight: 600, position: 'sticky', top: 0, background: 'var(--color-pane)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '4px 9px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' };
  return (
    <div style={{ maxHeight: 320, overflow: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', font: '400 11.5px var(--font-mono)', minWidth: '100%' }}>
        <thead><tr>{columns.map((c, i) => <th key={i} style={th}>{c}</th>)}</tr></thead>
        <tbody>{shown.map((r, ri) => <tr key={ri}>{columns.map((_, ci) => <td key={ci} style={td} title={r[ci] ?? ''}>{r[ci] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {rows.length > MAX_ROWS && <div style={{ padding: '6px 9px', color: 'var(--color-text-tertiary)', fontSize: 11 }}>+{rows.length - MAX_ROWS} more rows</div>}
    </div>
  );
}
