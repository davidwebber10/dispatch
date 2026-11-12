import { useEffect, useState } from 'react';
import { Check } from '@phosphor-icons/react';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { useAccounts, accountProviderOf, threadAccount } from '../../stores/accounts';
import { useIsMobile } from '../../hooks/useIsMobile';
import { hostCopy } from '../../lib/hostCopy';
import { Modal } from './Modal';

const HARNESS_NAME: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/**
 * "Switch account…" for one thread (multi-account, 2026-11-06): the signed-in accounts of its
 * harness, the current one marked. Picking another and confirming pins it on the thread and
 * restarts the thread under that login. Opened from the thread menu (right-click, ⋯, long-press)
 * and from the Details pane, on desktop and on the phone.
 */
export function AccountSwitchModal({ tab, onClose }: { tab: Terminal; onClose: () => void }) {
  const isMobile = useIsMobile();
  const view = useAccounts((s) => s.view);
  useEffect(() => { void useAccounts.getState().load(); }, []);
  const threadStatus = useThreadStatus((s) => s.byTerminal[tab.id]?.threadStatus);
  const midTurn = threadStatus === 'working' || threadStatus === 'starting';
  const provider = accountProviderOf(tab.type);
  const current = threadAccount(view, tab);
  const accounts = provider && view ? view[provider] : [];
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPretty = (tab.config as { transport?: string })?.transport === 'structured';
  // The shared Codex app-server has one login: a Codex Pretty thread may only run as cli.
  const blocked = (id: string) => tab.type === 'codex' && isPretty && id !== 'cli';
  const target = picked && picked !== current?.id ? accounts.find((a) => a.id === picked) ?? null : null;

  const confirm = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.switchAccount(tab.id, target.id, midTurn ? { force: true } : undefined);
      await useTabs.getState().loadTabs(tab.sessionId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch the account.');
      setBusy(false);
    }
  };

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: isMobile ? '12px 12px' : '9px 10px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', cursor: 'pointer', font: 'inherit' };
  // Never lead with the thread's name: a long one made the note read as one run-on sentence.
  const note = target
    ? tab.type === 'codex'
      ? `This thread restarts under “${target.label}” with a fresh Codex session. Its Dispatch history stays.`
      : `This thread restarts under “${target.label}” and resumes its session.`
    : null;

  return (
    <Modal open sheet={isMobile} title="Switch account" onClose={onClose} maxWidth={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {!view ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>{hostCopy('accounts.none', 'The daemon has no accounts yet. Update it to use more than one login.')}</span>
        ) : !provider ? (
          <span style={{ fontSize: 13, color: 'var(--color-text-tertiary)' }}>Only a Claude Code or Codex thread runs on an account.</span>
        ) : (
          <>
            <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              The {HARNESS_NAME[tab.type] ?? tab.type} account this thread runs on. Pick another to restart the thread under it.
            </span>
            <div role="radiogroup" aria-label="Account" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {accounts.map((a) => {
                const on = (picked ?? current?.id) === a.id;
                const off = blocked(a.id);
                return (
                  <button key={a.id} type="button" role="radio" aria-checked={on} disabled={off}
                    title={off ? 'A Codex Pretty thread runs on the CLI login only. Switch it to CLI mode first.' : undefined}
                    onClick={() => { if (!off) { setPicked(a.id); setError(null); } }}
                    style={{ ...row, opacity: off ? 0.45 : 1, cursor: off ? 'not-allowed' : 'pointer', borderColor: on ? 'var(--color-accent)' : 'var(--color-border)' }}>
                    <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', color: 'var(--color-accent)' }}>{on && <Check size={14} weight="bold" />}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: isMobile ? 15 : 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.label}</span>
                      <span style={{ font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>
                        {[a.email, a.plan, current?.id === a.id ? (current.pinned ? 'current' : 'current (the default)') : null].filter(Boolean).join(' · ') || ' '}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {note && (
              <div role="note" style={{ fontSize: 12.5, lineHeight: 1.5, color: midTurn ? 'var(--color-status-yellow)' : 'var(--color-text-secondary)' }}>
                {midTurn ? 'This thread is working: the switch stops its turn. ' : ''}{note}
              </div>
            )}
            {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--color-status-red)' }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button type="button" onClick={onClose} style={{ height: isMobile ? 40 : 32, padding: '0 14px', background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button type="button" disabled={!target || busy} onClick={() => void confirm()}
                style={{ height: isMobile ? 40 : 32, padding: '0 14px', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', font: 'inherit', fontSize: 13, fontWeight: 600, cursor: !target || busy ? 'default' : 'pointer', opacity: !target || busy ? 0.6 : 1 }}>
                {busy ? 'Switching…' : 'Switch and restart'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
