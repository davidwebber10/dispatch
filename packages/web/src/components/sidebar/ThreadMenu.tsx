import { useContributions } from '../../plugins/registry';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useHint } from '../../stores/hint';
import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';
import { copyText } from '../../lib/clipboard';
import { THREAD_TYPES } from '../../lib/harnesses';
import { ConfirmModal } from '../common/ConfirmModal';
import { RenameThreadModal } from './RenameThreadModal';
import { AutoArchiveModal } from './AutoArchiveModal';
import { AccountSwitchModal } from '../common/AccountSwitchModal';
import { Modal } from '../common/Modal';
import { DetailsPane } from '../inspector/DetailsPane';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pluginIcon } from '../../plugins/sdk';
import {
  PencilSimple, GitBranch, UserSwitch, Bell, BellSlash, Info, Copy, ArrowClockwise, ArrowCounterClockwise,
  Timer, Archive, PushPinSlash, CaretDown, CaretRight,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

/** Harnesses whose CLI can fork a session (core providers' buildBranchCommand). OpenCode
 *  runs only over ACP, which has no fork, so it is left out. */
const BRANCHABLE: string[] = ['claude-code', 'codex', 'grok'];

export type ThreadMenuAt = { tab: Terminal; x: number; y: number };
/** A plugin row the caller adds (the phone's thread header: plugins' right-column tabs). */
export type ThreadMenuPluginRow = { key: string; label: string; icon: Icon; onPick: (tab: Terminal) => void };

const item: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 9px', background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-primary)', cursor: 'pointer', fontSize: 13 };
/** A row in the phone's sheet: finger-sized. */
const sheetItem: React.CSSProperties = { ...item, gap: 12, padding: '11px 12px', fontSize: 15, borderRadius: 'var(--radius-md)' };
/** A quick-action tile at the top of the phone's sheet: icon above a short label. */
const tile: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0, height: 72, padding: '0 4px',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)',
  color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 500, cursor: 'pointer',
};
/** A group's small caption in the phone's sheet ("View", "Plugins"). */
const caption: React.CSSProperties = { padding: '10px 12px 2px', fontSize: 11.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' };
const rule = <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '6px 6px' }} />;
const ICON = 20;

/**
 * A thread row's options menu (the ⋯ button, right-click, long-press) and the dialogs it
 * opens: details, rename, auto-archive, archive. Shared by the project view (ProjectCard) and the
 * phone's cross-project Threads list, so both offer the same actions. Stays mounted while
 * `at` is null so a dialog opened from the menu outlives the menu itself.
 */
/** `leadView`: rows shown first in the phone sheet's View group (the thread header's CLI ⇄ Pretty
 *  switch); each closes the menu itself, through the `close` it is given. `pluginRows`: plugin rows
 *  the caller adds (its right-column tabs), listed with the registry's own thread-menu items.
 *  On a phone the rows are grouped (2026-11-07): a grid of the four most used actions, View,
 *  Plugins, a closed More for the maintenance actions, then Archive. Desktop stays a flat list. */
export function ThreadMenu({ at, onClose, onBranched, leadView, pluginRows }: {
  at: ThreadMenuAt | null; onClose: () => void; onBranched: (thread: Terminal) => void;
  leadView?: (close: () => void, rowStyle: React.CSSProperties) => React.ReactNode;
  pluginRows?: ThreadMenuPluginRow[];
}) {
  const [archiveTarget, setArchiveTarget] = useState<Terminal | null>(null);
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null);
  const [autoArchiveTarget, setAutoArchiveTarget] = useState<Terminal | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Terminal | null>(null);
  const [accountTarget, setAccountTarget] = useState<Terminal | null>(null);
  // Desktop shows the same details in its right-hand panel; a phone has no panel.
  const isMobile = useIsMobile();
  // Items plugins added (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3).
  const pluginItems = useContributions('threadMenu');
  // The phone sheet's More disclosure starts closed each time the sheet opens.
  const [moreOpen, setMoreOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState<ThreadMenuAt | null>(at);
  if (openedFor !== at) { setOpenedFor(at); if (moreOpen) setMoreOpen(false); }

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

  /** The id another thread can take straight into read_thread or message_thread (2026-11-06). */
  async function copyId(tab: Terminal) {
    try { await copyText(tab.id); useHint.getState().show('Thread ID copied'); } catch { useHint.getState().show('Could not copy the thread ID'); }
  }

  /** Clear a stuck working / needs-input / error status (and any spinner) back to idle. */
  async function resetStatus(tab: Terminal) {
    useTabs.getState().clearLoading(tab.id);
    try { await api.resetTerminalStatus(tab.id); await useTabs.getState().loadTabs(tab.sessionId); } catch { /* surfaced via connection state */ }
  }

  const pick = (fn: (tab: Terminal) => void) => () => { if (!at) return; const t = at.tab; onClose(); fn(t); };

  const isThread = (t: Terminal) => THREAD_TYPES.includes(t.type);
  const hasAccount = (t: Terminal) => t.type === 'claude-code' || t.type === 'codex';
  const alertsOn = (t: Terminal) => !!(t.config as { alertsEnabled?: boolean })?.alertsEnabled;

  // The desktop menu's rows: one flat list at the click.
  const menuItems = (at: ThreadMenuAt) => (
    <>
            {leadView?.(onClose, item)}
            {pluginRows?.map((p) => (
              <button key={p.key} onClick={pick(p.onPick)} style={item}><p.icon size={15} />{p.label}</button>
            ))}
            {(leadView || (pluginRows && pluginRows.length > 0)) && <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '4px 6px' }} />}
            {isMobile && THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(setDetailsTarget)} style={isMobile ? sheetItem : item}>Thread details</button>
            )}
            <button onClick={pick(setRenameTarget)} style={isMobile ? sheetItem : item}>{at.tab.type === 'file' ? 'Rename file' : 'Rename thread'}</button>
            {BRANCHABLE.includes(at.tab.type) && (
              <button onClick={pick((t) => void branch(t))} style={isMobile ? sheetItem : item}>Branch thread</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick((t) => void copyId(t))} style={isMobile ? sheetItem : item}>Copy thread ID</button>
            )}
            {pluginItems.filter((p) => !p.when || p.when({ tab: at.tab })).map((p) => (
              <button key={`${p.plugin}:${p.id}`} onClick={pick((t) => p.onPick({ tab: t }))} style={isMobile ? sheetItem : item}>{p.label}</button>
            ))}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(reload)} style={isMobile ? sheetItem : item}>Reload thread</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick((t) => void resetStatus(t))} style={isMobile ? sheetItem : item}>Reset status</button>
            )}
            {THREAD_TYPES.includes(at.tab.type) && (
              <button onClick={pick(setAutoArchiveTarget)} style={isMobile ? sheetItem : item}>Auto-archive…</button>
            )}
            {(at.tab.type === 'claude-code' || at.tab.type === 'codex') && (
              <button onClick={pick(setAccountTarget)} style={isMobile ? sheetItem : item}>Switch account…</button>
            )}
            {(at.tab.type === 'claude-code' || at.tab.type === 'codex') && canReceiveAlerts() && (
              <button onClick={pick((t) => void toggleAlerts(t))} style={isMobile ? sheetItem : item}>{(at.tab.config as { alertsEnabled?: boolean })?.alertsEnabled ? 'Disable alerts' : 'Enable alerts'}</button>
            )}
            {at.tab.type === 'file' ? (
              <button onClick={pick((t) => void archive(t))} style={isMobile ? sheetItem : item}>Unpin</button>
            ) : (
              <button onClick={pick(setArchiveTarget)} style={{ ...(isMobile ? sheetItem : item), color: 'var(--color-status-red)' }}>Archive thread</button>
            )}
    </>
  );

  /** A row in the phone's sheet: icon, label, and an optional plain-words line under it. */
  const row = (key: string, Glyph: Icon, label: string, onClick: () => void, hint?: string, extra: React.CSSProperties = {}) => {
    const hintId = hint ? `thread-menu-hint-${key}` : undefined;
    return (
      <button key={key} type="button" onClick={onClick} aria-label={hint ? label : undefined} aria-describedby={hintId} style={{ ...sheetItem, alignItems: hint ? 'flex-start' : 'center', ...extra }}>
        <Glyph size={ICON} style={{ flexShrink: 0, marginTop: hint ? 1 : 0 }} />
        {hint ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span>{label}</span>
            <span id={hintId} style={{ fontSize: 12.5, color: 'var(--color-text-tertiary)' }}>{hint}</span>
          </span>
        ) : label}
      </button>
    );
  };

  /** The phone's sheet (2026-11-07): it was 15 equal-weight rows with no way to tell what mattered.
   *  The handlers are the desktop menu's; only the arrangement differs. */
  const sheetItems = (at: ThreadMenuAt) => {
    const t = at.tab;
    // The four most used: Rename and Branch (what you do to a thread), Account (the answer to a usage
    // limit), Alerts (on/off at a glance, also from the Threads list, where no bell shows).
    const tiles: { key: string; Glyph: Icon; label: string; name: string; onClick: () => void; pressed?: boolean }[] = [
      { key: 'rename', Glyph: PencilSimple, label: 'Rename', name: t.type === 'file' ? 'Rename file' : 'Rename thread', onClick: pick(setRenameTarget) },
      ...(BRANCHABLE.includes(t.type) ? [{ key: 'branch', Glyph: GitBranch, label: 'Branch', name: 'Branch thread', onClick: pick((x) => void branch(x)) }] : []),
      ...(hasAccount(t) ? [{ key: 'account', Glyph: UserSwitch, label: 'Account', name: 'Switch account…', onClick: pick(setAccountTarget) }] : []),
      ...(hasAccount(t) && canReceiveAlerts()
        ? [{ key: 'alerts', Glyph: alertsOn(t) ? Bell : BellSlash, label: 'Alerts', name: alertsOn(t) ? 'Disable alerts' : 'Enable alerts', pressed: alertsOn(t), onClick: pick((x) => void toggleAlerts(x)) }]
        : []),
    ];
    const plugins = [
      ...(pluginRows ?? []).map((p) => row(`tab-${p.key}`, p.icon, p.label, pick(p.onPick))),
      ...pluginItems.filter((p) => !p.when || p.when({ tab: t }))
        .map((p) => row(`item-${p.plugin}-${p.id}`, pluginIcon(p.icon), p.label, pick((x) => p.onPick({ tab: x })))),
    ];
    const hasView = !!leadView || isThread(t);
    return (
      <>
        <div role="group" aria-label="Quick actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, padding: '2px 4px 6px' }}>
          {tiles.map((x) => (
            <button key={x.key} type="button" aria-label={x.name} aria-pressed={x.pressed} onClick={x.onClick}
              style={{ ...tile, ...(x.pressed ? { color: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : {}) }}>
              <x.Glyph size={22} weight={x.pressed ? 'fill' : 'regular'} />
              <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
            </button>
          ))}
        </div>
        {hasView && (
          <div role="group" aria-label="View" style={{ display: 'flex', flexDirection: 'column' }}>
            <div aria-hidden style={caption}>View</div>
            {leadView?.(onClose, sheetItem)}
            {isThread(t) && row('details', Info, 'Thread details', pick(setDetailsTarget))}
          </div>
        )}
        {plugins.length > 0 && (
          <div role="group" aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column' }}>
            <div aria-hidden style={caption}>Plugins</div>
            {plugins}
          </div>
        )}
        {isThread(t) && (
          <>
            {rule}
            <button type="button" aria-expanded={moreOpen} aria-controls="thread-menu-more" onClick={() => setMoreOpen((v) => !v)}
              style={{ ...sheetItem, color: 'var(--color-text-secondary)' }}>
              {moreOpen ? <CaretDown size={ICON} /> : <CaretRight size={ICON} />}More
            </button>
            {moreOpen && (
              <div id="thread-menu-more" style={{ display: 'flex', flexDirection: 'column' }}>
                {row('copy', Copy, 'Copy thread ID', pick((x) => void copyId(x)), 'Lets another thread read or message this one')}
                {row('reload', ArrowClockwise, 'Reload thread', pick(reload), 'Reconnect to the thread')}
                {row('reset', ArrowCounterClockwise, 'Reset status', pick((x) => void resetStatus(x)), 'Clear a stuck Working or Needs-you state')}
                {row('auto-archive', Timer, 'Auto-archive…', pick(setAutoArchiveTarget), 'Archive the thread on its own after a set time')}
              </div>
            )}
          </>
        )}
        {rule}
        {t.type === 'file'
          ? row('unpin', PushPinSlash, 'Unpin', pick((x) => void archive(x)))
          : row('archive', Archive, 'Archive thread', pick(setArchiveTarget), undefined, { color: 'var(--color-status-red)' })}
      </>
    );
  };

  return (
    <>
      {/* On a phone: the app's shared slide-up sheet, with bigger rows. On desktop: a small menu at the click. */}
      {isMobile ? (
        <Modal open={!!at} sheet title={at?.tab.label} onClose={onClose}>
          {at && <div role="menu" style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>{sheetItems(at)}</div>}
        </Modal>
      ) : at && createPortal(
        <>
          <div onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
          <div role="menu" style={{ position: 'fixed', top: at.y, left: Math.min(at.x, window.innerWidth - 184), zIndex: 301, minWidth: 168, background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', padding: 4, boxShadow: '0 20px 50px -20px var(--color-shadow-strong)' }}>
            {menuItems(at)}
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
      {accountTarget && (
        <AccountSwitchModal tab={accountTarget} onClose={() => setAccountTarget(null)} />
      )}
    </>
  );
}
