import { useState, useEffect } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { api } from '../../api/client';
import type { SearchMatch } from '../../api/types';
import { useThreadMode } from '../../stores/threadMode';
import { useViewJump } from '../../stores/viewJump';
import { useTabs } from '../../stores/tabs';

/**
 * Full-history search for a thread. Searches the entire transcript (not just the
 * loaded window); tapping a result switches the thread to View mode and jumps to
 * that line in the history.
 */
export function SearchOverlay({ terminalId, onClose }: { terminalId: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const v = q.trim();
    if (!v) { setMatches([]); setSearching(false); return; }
    let on = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try { const r = await api.searchConversation(terminalId, v); if (on) setMatches(r.matches); }
      catch { if (on) setMatches([]); }
      finally { if (on) setSearching(false); }
    }, 250);
    return () => { on = false; clearTimeout(t); };
  }, [q, terminalId]);

  const openResult = (line: number) => {
    useTabs.getState().setActiveTab(terminalId);
    useThreadMode.getState().set(terminalId, 'normal'); // View mode
    useViewJump.getState().jumpTo(terminalId, line);
    onClose();
  };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'calc(56px + env(safe-area-inset-top))', paddingLeft: 12, paddingRight: 12 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: '100%', maxHeight: '78vh', display: 'flex', flexDirection: 'column', background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 60px -20px rgba(0,0,0,.8)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
          <MagnifyingGlass size={16} color="var(--color-text-tertiary)" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this conversation…"
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', color: 'var(--color-text-primary)', fontSize: 14 }} />
          <button onClick={onClose} title="Close" style={{ background: 'none', border: 'none', color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex' }}><X size={16} /></button>
        </div>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {q.trim() && !searching && matches.length === 0 && (
            <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 13 }}>No matches.</div>
          )}
          {matches.map((m, i) => (
            <button key={i} onClick={() => openResult(m.line)}
              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border)', padding: '10px 12px', cursor: 'pointer' }}>
              <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--color-text-tertiary)' }}>{m.kind}</span>
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>{m.snippet}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
