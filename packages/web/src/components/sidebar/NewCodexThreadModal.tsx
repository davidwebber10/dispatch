import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import type { CodexRecentSession } from '../../api/types';

export function NewCodexThreadModal({ sessionId, onClose, onCreated }: { sessionId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<CodexRecentSession[] | null>(null);

  useEffect(() => {
    let on = true;
    api.recentCodexSessions(sessionId).then((r) => { if (on) setRecent(r); }).catch(() => { if (on) setRecent([]); });
    return () => { on = false; };
  }, [sessionId]);

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const t = await api.createTerminal(sessionId, { type: 'codex', label: name.trim() || undefined, externalId });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 36, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 14 };
  return (
    <Modal open onClose={onClose} title="New Codex Thread">
      <input autoFocus style={input} placeholder="Name (optional)" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
      <button disabled={busy} onClick={() => void create()} style={{ marginTop: 12, height: 38, width: '100%', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>Start new thread</button>

      {recent === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 13, marginTop: 18 }}><Spinner size={13} /> Loading recent sessions…</div>
      ) : recent.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>RESUME RECENT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 280, overflowY: 'auto' }}>
            {recent.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: '9px 11px', cursor: busy ? 'default' : 'pointer' }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.preview}</div>
                <div style={{ marginTop: 3, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}</div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
