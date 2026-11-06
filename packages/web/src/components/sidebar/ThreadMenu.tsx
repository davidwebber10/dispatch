import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useHint } from '../../stores/hint';
import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';
import { THREAD_TYPES } from '../../lib/harnesses';
import { ConfirmModal } from '../common/ConfirmModal';
import { RenameThreadModal } from './RenameThreadModal';
import { AutoArchiveModal } from './AutoArchiveModal';
import { Modal } from '../common/Modal';
import { DetailsPane } from '../inspector/DetailsPane';
import { useIsMobile } from '../../hooks/useIsMobile';

/** Harnesses whose CLI can fork a session (core providers' buildBranchCommand). OpenCode
 *  runs only over ACP, which has no fork, so it is left out. */
const BRANCHABLE: string[] = ['claude-code', 'codex', 'grok'];

export type ThreadMenuAt = { tab: Terminal; x: number; y: number };

const item: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 };

/**
 * A thread row's options menu (the ⋯ button, right-click, long-press) and the dialogs it
 * opens: details, rename, auto-archive, archive. Shared by the project view (ProjectCard) and the
 * phone's cross-project Threads list, so both offer the same actions. Stays mounted while
 * `at` is null so a dialog opened from the menu outlives the menu itself.
 */
export function ThreadMenu({ at, onClose, onBranched }: { at: ThreadMenuAt | null; onClose: () => void; onBranched: (thread: Terminal) => void }) {
  const [archiveTarget, setArchiveTarget] = useState<Terminal | null>(null);
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null);
  const [autoArchiveTarget, setAutoArchiveTarget] = useState<Terminal | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Terminal | null>(null);
  // Desktop shows the same details in its right-hand panel; a phone has no panel.
  const isMobile = useIsMobile();

  async function archive(tab: Terminal) {
    setArchiveTarget(null);
    try { await api.archiveTerminal(tab.id); await useTabs.getState().loadTabs(tab.sessionId); } catch { /* surfaced via connection state */ }
  }

  async function branch(tab: Terminal) {
    try {
      const t = await api.branchTerminal(tab.id);
      await useTabs.getState().loadTabs(tab.sessionId);
      useTabs.getState().markLoading(t.id);
      onBranched(t);
    } catch { /* e.g. 422 if the thread hasn't started a session yet */ }
  }

  async function toggleAlerts(tab: Terminal) {
    const on = !(tab.config as { alertsEnabled?: boolean })?.alertsEnabled;
    if (on) { const err = await ensurePushEnrolled(); if (err) { useHint.getState().show(err); return; } }
    void useTabs.getState().setAlertsEnabled(tab.id, on);
  }

  function reload(tab: Terminal) {
    useTabs.getState().markLoading(tab.id);
    void api.relaunchTerminal(tab.id).catch(() => { /* surfaced via connection state */ });
  }

  /** Clear a stuck working / needs-input / error status (and any spinner) back to idle. */
  async function resetStatus(tab: Terminal) {
    useTabs.getState().clearLoading(tab.id);
    try { await api.resetTerminalStatus(tab.id); await useTabs.getState().loadTabs(tab.sessionId); } catch { /* surfaced via connection state */ }
  }

  const pick = (fn: (tab: Terminal) => void) => () => { if (!at) return; const t = at.tab; onClose(); fn(t); };

  return (
    <>
      {at && createPortal(
        <>
          <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div role="menu" style={{ position: 'fixed', top: at.y, left: Math.min(at.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: '#1B1B1E', border: '1px solid #2C2C32', borderRadius: 9, padding: 4, boxShadow: '0 20px 50px -20px rgba(0,0,0,.8)' }}>
            {isMobile && THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(setDetailsTarget)} style={item}>Thread details</button>
            )}
            <button onClick={pick(setRenameTarget)} style={item}>{at.tab.type === 'file' ? 'Rename file' : 'Rename thread'}</button>
            {BRANCHABLE.includes(at.tab.type) && (
              <button onClick={pick((t) => void branch(t))} style={item}>Branch thread</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(reload)} style={item}>Reload thread</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick((t) => void resetStatus(t))} style={item}>Reset status</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(setAutoArchiveTarget)} style={item}>Auto-archive…</button>
            )}
            {(at.tab.type === 'claude-code' || at.tab.type === 'codex') && canReceiveAlerts() && (
              <button onClick={pick((t) => void toggleAlerts(t))} style={item}>{(at.tab.config as { alertsEnabled?: boolean })?.alertsEnabled ? 'Disable alerts' : 'Enable alerts'}</button>
            )}
            {at.tab.type === 'file' ? (
              <button onClick={pick((t) => void archive(t))} style={item}>Unpin</button>
            ) : (
              <button onClick={pick(setArchiveTarget)} style={{ ...item, color: 'var(--color-status-red)' }}>Archive thread</button>
            )}
          </div>
        </>,
        document.body,
      )}

      <ConfirmModal
        open={!!archiveTarget}
        title="Archive thread?"
        message={archiveTarget ? `“${archiveTarget.label}” will be archived. You can restore it later from the archive.` : ''}
        confirmLabel="Archive"
        danger
        onConfirm={() => { if (archiveTarget) void archive(archiveTarget); }}
        onCancel={() => setArchiveTarget(null)}
      />

      {renameTarget && (
        <RenameThreadModal terminalId={renameTarget.id} sessionId={renameTarget.sessionId} current={renameTarget.label} onClose={() => setRenameTarget(null)} />
      )}

      <Modal open={!!detailsTarget} sheet title="Thread details" onClose={() => setDetailsTarget(null)}>
        {detailsTarget && <DetailsPane projectId={detailsTarget.sessionId} terminalId={detailsTarget.id} />}
      </Modal>

      {autoArchiveTarget && (
        <AutoArchiveModal tab={autoArchiveTarget} onClose={() => setAutoArchiveTarget(null)} />
      )}
    </>
  );
}
