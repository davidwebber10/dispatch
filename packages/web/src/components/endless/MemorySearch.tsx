import { useEffect, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { useEndless } from '../../stores/endless';
import type { EndlessSearchHit } from '../../api/types';

/** The daemon marks snippet matches with \u0002 … \u0003 (store.ts SNIPPET_OPEN/CLOSE). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\u0002[^\u0003]*\u0003)/g);
  return <>{parts.map((p, k) => (p.startsWith('\u0002') ? <mark key={k}>{p.slice(1, -1)}</mark> : <span key={k}>{p}</span>))}</>;
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Full-text memory search for the human only (spec section 7); the model has no search tool. */
export function MemorySearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<EndlessSearchHit[] | null>(null);
  const [failed, setFailed] = useState(false);
  const filter = useEndless((s) => s.filter);

  useEffect(() => {
    const query = q.trim();
    setFailed(false);
    if (!query) { setResults(null); return; }
    // `live` is false once the query or filter changes, so a stale response cannot overwrite a newer one.
    let live = true;
    const t = setTimeout(() => {
      api.endlessSearch(query, filter)
        .then((r) => { if (live) setResults(r.results); })
        .catch(() => { if (live) { setResults([]); setFailed(true); } });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, filter]);

  const open = (i: number) => {
    setQ('');
    setResults(null);
    void useEndless.getState().openAt(i).catch(() => {});
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <MagnifyingGlass size={15} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--color-text-tertiary)' }} />
      <input aria-label="Search memory" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory"
        style={{ width: '100%', height: 32, padding: '0 10px 0 30px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-elevated)', color: 'var(--color-text-primary)', fontSize: 16 }} />
      {results && (
        <div role="listbox" aria-label="Memory search results"
          style={{ position: 'absolute', top: 36, left: 0, right: 0, zIndex: 20, maxHeight: '60vh', overflowY: 'auto', borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-pane)', boxShadow: '0 12px 28px -8px rgba(0,0,0,.6)' }}>
          {results.length === 0 ? (
            <div style={{ padding: 12, color: 'var(--color-text-tertiary)', fontSize: 13 }}>{failed ? 'Search is unavailable' : 'No matches'}</div>
          ) : results.map((h) => (
            <button key={h.i} type="button" role="option" aria-selected={false} onClick={() => open(h.i)}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--color-border)', background: 'transparent', cursor: 'pointer', color: 'var(--color-text-primary)' }}>
              <div style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                {when(h.createdAt)}{h.projectName ? ` · ${h.projectName}` : ''} · {h.kind}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.45, marginTop: 2, wordBreak: 'break-word' }}><Snippet text={h.snippet} /></div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
