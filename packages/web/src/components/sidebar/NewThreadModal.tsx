import { useEffect, useState } from 'react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { AutoArchiveField } from './AutoArchiveField';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { timeAgo } from '../../lib/time';
import { DEFAULT_AUTO_ARCHIVE_MS } from '../../lib/autoArchive';
import type { CcRecentSession, CodexRecentSession } from '../../api/types';

export type NewThreadKind = 'claude-code' | 'claude-structured' | 'codex' | 'shell';

/** The four things the New Thread menu offers, and what each maps to on the wire. */
const KINDS: { kind: NewThreadKind; label: string; type: string; config?: Record<string, unknown> }[] = [
  { kind: 'claude-code', label: 'Claude Code', type: 'claude-code' },
  { kind: 'claude-structured', label: 'Claude (structured)', type: 'claude-code', config: { transport: 'structured' } },
  { kind: 'codex', label: 'Codex', type: 'codex' },
  { kind: 'shell', label: 'Terminal', type: 'shell' },
];

export function NewThreadModal({ sessionId, initialKind, onClose, onCreated }: {
  sessionId: string;
  initialKind: NewThreadKind;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [kind, setKind] = useState<NewThreadKind>(initialKind);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoArchive, setAutoArchive] = useState(false);
  const [autoArchiveMs, setAutoArchiveMs] = useState(DEFAULT_AUTO_ARCHIVE_MS);
  const [recent, setRecent] = useState<CcRecentSession[] | CodexRecentSession[] | null>(null);

  const spec = KINDS.find((k) => k.kind === kind)!;
  // Resuming an on-disk session only makes sense for the kinds that take an
  // externalId today: the PTY Claude Code thread and Codex.
  const canResume = kind === 'claude-code' || kind === 'codex';

  useEffect(() => {
    // Clear any stale list from the previously-selected kind right away, so a
    // switch from e.g. codex -> claude-code never flashes the old entries.
    setRecent(null);
    if (!canResume) return;
    let on = true;
    const fetcher = kind === 'codex' ? api.recentCodexSessions : api.recentCcSessions;
    fetcher(sessionId).then((r) => { if (on) setRecent(r); }).catch(() => { if (on) setRecent([]); });
    return () => { on = false; };
  }, [sessionId, kind, canResume]);

  async function create(externalId?: string) {
    if (busy) return;
    setBusy(true);
    try {
      // Build the config fresh at creation — nothing to merge with yet.
      const config: Record<string, unknown> = { ...(spec.config ?? {}) };
      if (autoArchive) { config.autoArchive = true; config.autoArchiveMs = autoArchiveMs; }

      const t = await api.createTerminal(sessionId, {
        type: spec.type,
        label: name.trim() || undefined,
        externalId,
        ...(Object.keys(config).length ? { config } : {}),
      });
      await useTabs.getState().loadTabs(sessionId);
      useTabs.getState().markLoading(t.id);
      onCreated(t.id);
      onClose();
    } catch { setBusy(false); }
  }

  const input: React.CSSProperties = { height: 36, width: '100%', padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, color: 'var(--color-text-primary)', fontSize: 14 };
  const labelStyle: React.CSSProperties = { display: 'block', font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 6 };

  return (
    <Modal open onClose={onClose} title="New Thread">
      <label style={labelStyle} htmlFor="new-thread-type">TYPE</label>
      <select id="new-thread-type" aria-label="Thread type" value={kind}
        onChange={(e) => setKind(e.target.value as NewThreadKind)} style={input}>
        {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>

      <label style={{ ...labelStyle, marginTop: 14 }} htmlFor="new-thread-name">NAME</label>
      <input id="new-thread-name" autoFocus style={input} placeholder="Optional" value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />

      <AutoArchiveField
        enabled={autoArchive}
        ms={autoArchiveMs}
        onChange={(enabled, ms) => { setAutoArchive(enabled); setAutoArchiveMs(ms); }}
      />

      <button disabled={busy} onClick={() => void create()}
        style={{ marginTop: 14, height: 38, width: '100%', background: 'var(--color-accent)', border: 'none', borderRadius: 9, color: '#08240F', fontWeight: 600, fontSize: 14, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}>
        Start new thread
      </button>

      {canResume && (recent === null ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-tertiary)', fontSize: 13, marginTop: 18 }}>
          <Spinner size={13} /> Loading recent sessions…
        </div>
      ) : recent.length > 0 ? (
        <div style={{ marginTop: 18 }}>
          <div style={{ font: '600 10px var(--font-mono)', letterSpacing: '1.2px', color: 'var(--color-text-tertiary)', marginBottom: 8 }}>RESUME RECENT</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
            {recent.map((s) => (
              <button key={s.id} disabled={busy} onClick={() => void create(s.id)}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 8, padding: '9px 11px', cursor: busy ? 'default' : 'pointer' }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.preview}</div>
                <div style={{ marginTop: 3, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                  {timeAgo(new Date(s.mtime).toISOString())} · {s.messageCount}{s.truncated ? '+' : ''} msg{s.messageCount === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null)}
    </Modal>
  );
}
