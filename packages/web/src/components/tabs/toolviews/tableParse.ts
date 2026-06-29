export interface ParsedTable { columns: string[]; rows: string[][]; }

function fmt(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

function parseMarkdownTable(t: string): ParsedTable | null {
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  if (!lines[0].includes('|')) return null;
  // separator row: only spaces, colons, pipes, dashes — and at least one dash
  if (!/^[\s:|-]+$/.test(lines[1]) || !lines[1].includes('-')) return null;
  const cells = (l: string) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  return { columns: cells(lines[0]), rows: lines.slice(2).map(cells) };
}

export function parseTable(text: string): ParsedTable | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  // 1) JSON array of flat-ish objects
  if (t[0] === '[') {
    try {
      const v = JSON.parse(t);
      if (Array.isArray(v) && v.length && v.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        const cols: string[] = [];
        for (const row of v) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
        return { columns: cols, rows: v.map((row) => cols.map((c) => fmt((row as Record<string, unknown>)[c]))) };
      }
    } catch { /* fall through */ }
  }
  // 2) markdown table
  const md = parseMarkdownTable(t);
  if (md) return md;
  // 3) TSV
  if (t.includes('\t')) {
    const lines = t.split('\n').filter((l) => l.length);
    if (lines.length >= 2) return { columns: lines[0].split('\t'), rows: lines.slice(1).map((l) => l.split('\t')) };
  }
  return null;
}
