import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, TrashSimple } from '@phosphor-icons/react';
import { parseCsv, serializeCsv, editCell, insertRow, deleteRow, columnCount, type CsvDoc } from '../../lib/csv';
import { copyText } from '../../lib/clipboard';

const ROW_H = 28;                // fixed row height — what makes windowing arithmetic possible
const OVERSCAN = 10;
const VIEWPORT_GUESS = 600;      // used before the first scroll measurement

/** Styles mirror ResultTable (toolviews/QueryView.tsx) so the grid looks native here. */
const TH: React.CSSProperties = {
  textAlign: 'left', padding: '5px 9px', borderBottom: '1px solid var(--color-border)',
  borderRight: '1px solid var(--color-border)', color: 'var(--color-text-secondary)',
  fontWeight: 600, position: 'sticky', top: 0, background: 'var(--color-pane)',
  whiteSpace: 'nowrap', height: ROW_H, boxSizing: 'border-box',
};
const TD: React.CSSProperties = {
  padding: '4px 9px', borderBottom: '1px solid var(--color-border)',
  borderRight: '1px solid var(--color-border)', color: 'var(--color-text-primary)',
  whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis',
  height: ROW_H, boxSizing: 'border-box', cursor: 'cell',
};
const GUTTER: React.CSSProperties = {
  ...TD, color: 'var(--color-text-tertiary)', textAlign: 'right', cursor: 'default',
  background: 'var(--color-pane)', position: 'sticky', left: 0, width: 52, maxWidth: 52,
};

/**
 * `path` is not decoration: parseCsv reads the extension to force a tab delimiter for a `.tsv`.
 * Without it a TSV whose cells contain commas (which is exactly WHY you'd pick TSV) is detected as
 * comma-delimited, and the first edit rewrites the row on commas — losing the tabs and the data
 * between them. Always pass the real file path.
 */
/** A cell coordinate in doc.rows space: r indexes doc.rows (0 is the header), c the column. */
interface Cell { r: number; c: number }

export function CsvGrid({ content, path, onChange }: { content: string; path: string; onChange: (next: string) => void }) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(VIEWPORT_GUESS);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Spreadsheet-style selection: click focuses a cell, Shift-click / drag extends a
  // rectangle, arrows move, Ctrl/Cmd+C copies the rectangle as TSV (pastes into
  // Excel/Sheets with cells intact). Coordinates live in doc.rows space, NOT the DOM:
  // the windowed renderer only mounts visible rows, and copy must read the whole doc.
  const [sel, setSel] = useState<{ anchor: Cell; focus: Cell } | null>(null);
  const dragging = useRef(false);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  // Measure the real viewport before first paint (no flash of a wrong window), and keep it
  // correct as the pane is resized — VIEWPORT_GUESS is only ever the pre-measurement value.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportH(el.clientHeight);
    if (typeof ResizeObserver === 'undefined') return; // not available in some test environments (jsdom)
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Parse the incoming text — but reuse the doc we just produced ourselves rather than
  // re-parsing the whole file on every keystroke-commit. Only an EXTERNAL change (an edit made
  // in the Raw tab) actually re-parses.
  // The cache is keyed on the PATH as well as the text: the delimiter is a function of both, so a
  // doc parsed for `a.csv` must never be served for `a.tsv` (the grid would be right but every
  // subsequent edit would serialize on the wrong delimiter).
  const lastRef = useRef<{ text: string; path: string; doc: CsvDoc } | null>(null);
  const parsed = useMemo(() => {
    if (lastRef.current && lastRef.current.text === content && lastRef.current.path === path) {
      return { doc: lastRef.current.doc, error: null as string | null };
    }
    try {
      const doc = parseCsv(content, path);
      lastRef.current = { text: content, path, doc };
      return { doc, error: null as string | null };
    } catch (err: any) {
      return { doc: null, error: String(err?.message ?? err) };
    }
  }, [content, path]);

  // Never render a grid over a file we failed to parse — an edit through a wrong parse
  // would silently corrupt the user's data. Raw mode is still right there.
  if (!parsed.doc) {
    return (
      <div style={{ padding: 16, color: 'var(--color-text-secondary)', font: '400 12px var(--font-mono)' }}>
        This file could not be parsed as CSV ({parsed.error}). Switch to <strong>Raw</strong> to edit it as text.
      </div>
    );
  }

  const doc = parsed.doc;

  function commit(next: CsvDoc) {
    const text = serializeCsv(next);
    lastRef.current = { text, path, doc: next };   // pre-seed so the memo above doesn't re-parse
    onChange(text);
  }

  function startEdit(row: number, col: number) {
    setEditing({ row, col });
    setDraft(doc.rows[row]?.cells[col] ?? '');
    setSel({ anchor: { r: row, c: col }, focus: { r: row, c: col } });
  }

  function commitEdit(advance: 'down' | 'right' | null) {
    if (!editing) return;
    const { row, col } = editing;
    if (draft !== (doc.rows[row]?.cells[col] ?? '')) commit(editCell(doc, row, col, draft));
    setEditing(null);
    if (advance === 'down' && row + 1 < doc.rows.length) startEdit(row + 1, col);
    if (advance === 'right' && col + 1 < cols) startEdit(row, col + 1);
  }

  const cols = Math.max(1, columnCount(doc));
  const header = doc.rows[0];
  const dataCount = Math.max(0, doc.rows.length - 1);

  const rect = sel
    ? {
        r0: Math.min(sel.anchor.r, sel.focus.r), r1: Math.max(sel.anchor.r, sel.focus.r),
        c0: Math.min(sel.anchor.c, sel.focus.c), c1: Math.max(sel.anchor.c, sel.focus.c),
      }
    : null;
  const inSel = (r: number, c: number) =>
    !!rect && r >= rect.r0 && r <= rect.r1 && c >= rect.c0 && c <= rect.c1;
  const isFocus = (r: number, c: number) => !!sel && sel.focus.r === r && sel.focus.c === c;

  function cellMouseDown(ev: React.MouseEvent, r: number, c: number) {
    if (ev.button !== 0) return;
    // Replace native text selection with the cell rectangle (and keep a mousedown
    // from blurring the grid, which would kill the keyboard shortcuts).
    ev.preventDefault();
    scrollRef.current?.focus();
    dragging.current = true;
    setSel((prev) => (ev.shiftKey && prev ? { anchor: prev.anchor, focus: { r, c } } : { anchor: { r, c }, focus: { r, c } }));
  }

  function cellMouseEnter(r: number, c: number) {
    if (dragging.current) setSel((prev) => (prev ? { anchor: prev.anchor, focus: { r, c } } : prev));
  }

  async function copySelection() {
    if (!rect) return;
    const lines: string[] = [];
    for (let r = rect.r0; r <= rect.r1; r++) {
      const row: string[] = [];
      for (let c = rect.c0; c <= rect.c1; c++) row.push(doc.rows[r]?.cells[c] ?? '');
      lines.push(row.join('\t'));
    }
    try { await copyText(lines.join('\n')); }
    catch { window.alert('Copy failed — the clipboard is unavailable.'); }
  }

  /** Keep the focused cell inside the scroll window (header row is sticky, skip it). */
  function ensureVisible(r: number) {
    const el = scrollRef.current;
    if (!el || r === 0) return;
    const top = ROW_H + (r - 1) * ROW_H; // content y of the row (thead occupies the first ROW_H)
    if (top < el.scrollTop + ROW_H) el.scrollTop = top - ROW_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }

  function gridKeyDown(ev: React.KeyboardEvent) {
    if (editing) return; // the cell input owns the keyboard, including native copy
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'c' || ev.key === 'C')) {
      if (rect) { ev.preventDefault(); void copySelection(); }
      return;
    }
    if (!sel) return;
    const move: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    const d = move[ev.key];
    if (d) {
      ev.preventDefault();
      const r = Math.min(Math.max(sel.focus.r + d[0], 0), doc.rows.length - 1);
      const c = Math.min(Math.max(sel.focus.c + d[1], 0), cols - 1);
      setSel(ev.shiftKey ? { anchor: sel.anchor, focus: { r, c } } : { anchor: { r, c }, focus: { r, c } });
      ensureVisible(r);
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); startEdit(sel.focus.r, sel.focus.c); }
    else if (ev.key === 'Escape') setSel(null);
  }

  /** Selection decoration for a cell, layered over the base TD/TH style. */
  function selStyle(r: number, c: number): React.CSSProperties {
    if (!inSel(r, c)) return {};
    return {
      background: '#33333c',
      ...(isFocus(r, c) ? { boxShadow: 'inset 0 0 0 1.5px var(--color-accent)' } : {}),
    };
  }

  // Windowing: only the visible slice of data rows is in the DOM. A 100k-row CSV would
  // otherwise put 100k <tr> nodes on the page and lock the tab.
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const visible = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
  const last = Math.min(dataCount, first + visible);
  const padTop = first * ROW_H;
  const padBottom = Math.max(0, (dataCount - last) * ROW_H);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div
        ref={scrollRef}
        tabIndex={0}
        onKeyDown={gridKeyDown}
        onScroll={(e) => { setScrollTop(e.currentTarget.scrollTop); setViewportH(e.currentTarget.clientHeight); }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto', outline: 'none' }}
      >
        <table style={{ borderCollapse: 'collapse', font: '400 11.5px var(--font-mono)', minWidth: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...TH, ...GUTTER, position: 'sticky', top: 0, left: 0, zIndex: 2 }} />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} style={{ ...TH, ...selStyle(0, c) }} onDoubleClick={() => startEdit(0, c)}
                  onMouseDown={(ev) => cellMouseDown(ev, 0, c)} onMouseEnter={() => cellMouseEnter(0, c)}>
                  {editing && editing.row === 0 && editing.col === c
                    ? <CellInput draft={draft} setDraft={setDraft} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                    : (header?.cells[c] ?? '')}
                </th>
              ))}
              <th style={{ ...TH, width: 32 }} />
            </tr>
          </thead>
          <tbody>
            {/* Spacers stand in for the rows that are NOT in the DOM, so the scrollbar reflects the
                whole file. `height` on a bare <tr> is only a floor — an empty row can still collapse
                and the file becomes unscrollable past the first window. The height has to hang off a
                real <td> (gutter + data columns + the delete-button column). */}
            {padTop > 0 && (
              <tr aria-hidden>
                <td colSpan={cols + 2} style={{ height: padTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {Array.from({ length: last - first }, (_, k) => {
              const di = first + k;          // index among DATA rows
              const ri = di + 1;             // index in doc.rows (0 is the header)
              return (
                <tr key={ri}>
                  <td style={GUTTER}>{ri}</td>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} style={{ ...TD, ...selStyle(ri, c) }} title={doc.rows[ri]?.cells[c] ?? ''} onDoubleClick={() => startEdit(ri, c)}
                      onMouseDown={(ev) => cellMouseDown(ev, ri, c)} onMouseEnter={() => cellMouseEnter(ri, c)}>
                      {editing && editing.row === ri && editing.col === c
                        ? <CellInput draft={draft} setDraft={setDraft} onCommit={commitEdit} onCancel={() => setEditing(null)} />
                        : (doc.rows[ri]?.cells[c] ?? '')}
                    </td>
                  ))}
                  <td style={{ ...TD, width: 32, cursor: 'default' }}>
                    <button
                      title="Delete row"
                      onClick={() => { if (window.confirm(`Delete row ${ri}?`)) commit(deleteRow(doc, ri)); }}
                      style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', padding: 0 }}
                    >
                      <TrashSimple size={13} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden>
                <td colSpan={cols + 2} style={{ height: padBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 9px', borderTop: '1px solid var(--color-border)', color: 'var(--color-text-tertiary)', fontSize: 11 }}>
        <button
          title="Add row"
          onClick={() => commit(insertRow(doc, doc.rows.length))}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: '1px solid var(--color-border)', borderRadius: 6, color: 'var(--color-text-secondary)', cursor: 'pointer', padding: '3px 8px', fontSize: 11 }}
        >
          <Plus size={12} /> Add row
        </button>
        <span>{dataCount} rows × {cols} columns</span>
        {sel && (
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)' }}>
            {sel.focus.r === 0 ? 'header' : `row ${sel.focus.r}`} · {header?.cells[sel.focus.c] || `col ${sel.focus.c + 1}`}
            {rect && (rect.r0 !== rect.r1 || rect.c0 !== rect.c1)
              ? ` · ${(rect.r1 - rect.r0 + 1) * (rect.c1 - rect.c0 + 1)} cells`
              : ''} · Ctrl+C copies
          </span>
        )}
      </div>
    </div>
  );
}

function CellInput({ draft, setDraft, onCommit, onCancel }: {
  draft: string;
  setDraft: (v: string) => void;
  onCommit: (advance: 'down' | 'right' | null) => void;
  onCancel: () => void;
}) {
  // Escape unmounts this input (the parent clears `editing`), and removing a focused element
  // fires a native blur. Today React's synthetic event system happens not to forward that
  // unmount-caused blur back into the tree, so onBlur's onCommit(null) never runs — but that's
  // unwritten internal behavior, not a contract. Without this guard, a future React change could
  // make Escape COMMIT the value the user just cancelled: silent data loss into a file on disk.
  // Setting the flag before calling onCancel() makes the cancellation explicit instead of
  // accidental, so onBlur is guaranteed to no-op no matter how the unmount-blur is delivered.
  const cancelledRef = useRef(false);
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (cancelledRef.current) return; onCommit(null); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit('down'); }
        else if (e.key === 'Tab') { e.preventDefault(); onCommit('right'); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelledRef.current = true; onCancel(); }
      }}
      style={{ width: '100%', background: 'var(--color-terminal)', border: '1px solid var(--color-accent)', borderRadius: 3, color: 'var(--color-text-primary)', font: '400 11.5px var(--font-mono)', padding: '1px 3px', outline: 'none' }}
    />
  );
}
