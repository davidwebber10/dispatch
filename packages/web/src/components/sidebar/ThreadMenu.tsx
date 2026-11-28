import { MenuBadgeCount } from '../../plugins/menuBadge';
import { useContributions, type InspectorTabCtx, type MenuBadge } from '../../plugins/registry';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '../../api/types';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useHint } from '../../stores/hint';
import { useSecrets } from '../../stores/secrets';
import { canReceiveAlerts, ensurePushEnrolled } from '../../lib/push';
import { copyText } from '../../lib/clipboard';
import { THREAD_TYPES } from '../../lib/harnesses';
import { ConfirmModal } from '../common/ConfirmModal';
import { RenameThreadModal } from './RenameThreadModal';
import { AutoArchiveModal } from './AutoArchiveModal';
import { SIZES, FlyOut, MenuRow, MenuTiles, moveFocus, rule, captionBase, type Density } from './menuParts';
import { AccountSwitchModal } from '../common/AccountSwitchModal';
import { Modal } from '../common/Modal';
import { DetailsPane } from '../inspector/DetailsPane';
import { WhyPanel } from '../inspector/WhyPanel';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pluginIcon } from '../../plugins/sdk';
import {
  PencilSimple, GitBranch, UserSwitch, Bell, BellSlash, Info, Copy, ArrowClockwise, ArrowCounterClockwise,
  Timer, Archive, PushPinSlash, Key, Question, DownloadSimple,
} from '@phosphor-icons/react';
import { can } from '../../lib/profile';
import type { Icon } from '@phosphor-icons/react';
import { fontVar } from '../../lib/fontSize';

/** Harnesses whose CLI can fork a session (core providers' buildBranchCommand). OpenCode
 *  runs only over ACP, which has no fork, so it is left out. */
const BRANCHABLE: string[] = ['claude-code', 'codex', 'grok'];

export type ThreadMenuAt = { tab: Terminal; x: number; y: number };
/** A plugin row the caller adds (the phone's thread header: plugins' right-column tabs). */
export type ThreadMenuPluginRow = { key: string; label: string; icon: Icon; onPick: (tab: Terminal) => void; badge?: MenuBadge<InspectorTabCtx> };

/** The thread types with a conversation to download (a shell has none). */
const EXPORTABLE = ['claude-code', 'codex', 'grok', 'opencode'];

/**
 * A thread row's options menu (the ⋯ button, right-click, long-press) and the dialogs it
 * opens: details, rename, auto-archive, archive. Shared by the project view (ProjectCard) and the
 * phone's cross-project Threads list, so both offer the same actions. Stays mounted while
 * `at` is null so a dialog opened from the menu outlives the menu itself.
 */
/** `leadView`: rows shown first in the View group (the thread header's CLI ⇄ Pretty
 *  switch); each closes the menu itself, through the `close` it is given. `pluginRows`: plugin rows
 *  the caller adds (its right-column tabs), listed with the registry's own thread-menu items.
 *  The rows are grouped (2026-11-07): a grid of the four most used actions, View, Plugins, a closed
 *  More for the maintenance actions, then Archive. The phone shows them in a sheet, the desktop in a
 *  fly-out at the click; the body is the same. */
export function ThreadMenu({ at, onClose, onBranched, leadView, pluginRows, inline = false }: {
  at: ThreadMenuAt | null; onClose: () => void; onBranched: (thread: Terminal) => void;
  /** The menu's tiles and rows drawn in place, with no fly-out or sheet: the desktop right column (2026-11-13). */
  inline?: boolean;
  leadView?: (close: () => void, rowStyle: React.CSSProperties) => React.ReactNode;
  pluginRows?: ThreadMenuPluginRow[];
}) {
  const [archiveTarget, setArchiveTarget] = useState<Terminal | null>(null);
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null);
  const [autoArchiveTarget, setAutoArchiveTarget] = useState<Terminal | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<Terminal | null>(null);
  const [accountTarget, setAccountTarget] = useState<Terminal | null>(null);
  // The "Why is this thread in this state?" panel (W2-G).
  const [whyTarget, setWhyTarget] = useState<Terminal | null>(null);
  const isMobile = useIsMobile();
  // Items plugins added (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3).
  const pluginItems = useContributions('threadMenu');
  // The Doppler token switch exists only when the owner chose "only threads that I turn on" (W1-C).
  const tokenOptIn = useSecrets((s) => !!s.status?.connected && s.status?.tokenScope === 'opted-in');
  const menuOpen = !!at;
  // No secrets call where Doppler is hidden (lib/profile.ts): the business workspace has none.
  useEffect(() => { if (menuOpen && can('settings.secrets')) void useSecrets.getState().loadScope(); }, [menuOpen]);

  async function archive(tab: Terminal) {
    setArchiveTarget(null);
    await useTabs.getState().archive(tab.id); // optimistic (W2-I): the row goes at once; a failure puts it back with a hint
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

  /** "Download thread" (owner, 2026-11-13): the whole conversation as one file, to paste into another model. */
  async function downloadThread(tab: Terminal) {
    useHint.getState().show('Downloading thread…');
    try { await api.exportThread(tab.id); } catch { useHint.getState().show('Could not download the thread'); }
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

  /** Turn the Doppler token on or off for this thread's shell. It applies at the thread's next start. */
  async function toggleSecretsEnv(tab: Terminal) {
    const on = !secretsEnvOn(tab);
    try {
      await api.setThreadSecretsEnv(tab.id, on);
      await useTabs.getState().loadTabs(tab.sessionId);
      useHint.getState().show(on ? 'Doppler token on for this thread. Reload the thread to apply it.' : 'Doppler token off for this thread. Reload the thread to apply it.');
    } catch { useHint.getState().show('Could not change the Doppler token switch'); }
  }

  const pick = (fn: (tab: Terminal) => void) => () => { if (!at) return; const t = at.tab; onClose(); fn(t); };

  const isThread = (t: Terminal) => THREAD_TYPES.includes(t.type);
  const hasAccount = (t: Terminal) => t.type === 'claude-code' || t.type === 'codex';
  const secretsEnvOn = (t: Terminal) => (t.config as { secretsEnv?: boolean })?.secretsEnv === true;
  // Every Codex Pretty thread shares one app-server process, so no per-thread environment reaches it.
  const canTakeToken = (t: Terminal) => !(t.type === 'codex' && (t.config as { transport?: string })?.transport === 'structured');
  const alertsOn = (t: Terminal) => !!(t.config as { alertsEnabled?: boolean })?.alertsEnabled;

  const density: Density = isMobile ? 'sheet' : 'popover';
  const z = SIZES[density];

  const row = (key: string, Glyph: Icon, label: string, onClick: () => void, hint?: string, extra: React.CSSProperties = {}, trailing?: React.ReactNode) => (
    <MenuRow key={key} z={z} id={`thread-menu-hint-${key}`} Glyph={Glyph} label={label} onClick={onClick} hint={hint} extra={extra} trailing={trailing} />
  );

  /** The menu's groups (2026-11-07), the same in both shells: it was 15 equal-weight rows with no way
   *  to tell what mattered. The phone sheet got these first; the desktop fly-out shows them too. */
  const body = (at: ThreadMenuAt) => {
    const t = at.tab;
    // The four most used: Rename and Branch (what you do to a thread), Account (the answer to a usage
    // limit), Alerts (on/off at a glance, also from the Threads list, where no bell shows).
    const tiles: { key: string; Glyph: Icon; label: string; name: string; onClick: () => void; pressed?: boolean }[] = [
      { key: 'rename', Glyph: PencilSimple, label: 'Rename', name: t.type === 'file' ? 'Rename file' : 'Rename thread', onClick: pick(setRenameTarget) },
      ...(BRANCHABLE.includes(t.type) && can('threads.git') ? [{ key: 'branch', Glyph: GitBranch, label: 'Branch', name: 'Branch thread', onClick: pick((x) => void branch(x)) }] : []),
      ...(hasAccount(t) ? [{ key: 'account', Glyph: UserSwitch, label: 'Account', name: 'Switch account…', onClick: pick(setAccountTarget) }] : []),
      ...(hasAccount(t) && canReceiveAlerts()
        ? [{ key: 'alerts', Glyph: alertsOn(t) ? Bell : BellSlash, label: 'Alerts', name: alertsOn(t) ? 'Disable alerts' : 'Enable alerts', pressed: alertsOn(t), onClick: pick((x) => void toggleAlerts(x)) }]
        : []),
    ];
    const plugins = [
      ...(pluginRows ?? []).map((p) => row(`tab-${p.key}`, p.icon, p.label, pick(p.onPick), undefined, {}, p.badge ? <MenuBadgeCount badge={p.badge} ctx={{ terminalId: t.id, sessionId: t.sessionId ?? null }} /> : undefined)),
      ...pluginItems.filter((p) => !p.when || p.when({ tab: t }))
        .map((p) => row(`item-${p.plugin}-${p.id}`, pluginIcon(p.icon), p.label, pick((x) => p.onPick({ tab: x })), undefined, {}, p.badge ? <MenuBadgeCount badge={p.badge} ctx={{ tab: t }} /> : undefined)),
    ];
    // Desktop shows Thread details in its right-hand panel; a phone has no panel.
    // Not in place: that menu is inside Thread details already (the right column, the phone's details sheet).
    const details = isMobile && isThread(t) && !inline;
    const hasView = !!leadView || details;
    const caption = { ...captionBase, ...z.caption };
    const tilesNode = <MenuTiles z={z} tiles={tiles} />;
    const listNode = (
      <>
        {/* On a phone the caller's rows and Thread details are the first rows of the list, not a section
            (owner, 2026-11-13). The desktop keeps its View label over the caller's rows. */}
        {hasView && (isMobile ? (
          <>
            {leadView?.(onClose, z.row)}
            {details && row('details', Info, 'Thread details', pick(setDetailsTarget))}
          </>
        ) : (
          <div role="group" aria-label="View" style={{ display: 'flex', flexDirection: 'column' }}>
            <div aria-hidden style={caption}>View</div>
            {leadView?.(onClose, z.row)}
            {details && row('details', Info, 'Thread details', pick(setDetailsTarget))}
          </div>
        ))}
        {plugins.length > 0 && can('settings.plugins') && (
          <div role="group" aria-label="Plugins" style={{ display: 'flex', flexDirection: 'column' }}>
            <div aria-hidden style={caption}>Plugins</div>
            {plugins}
          </div>
        )}
        {isThread(t) && (
          <>
            {/* No More fold (owner, 2026-11-13: "it should just show the options"). */}
            {rule}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {EXPORTABLE.includes(t.type) && row('download', DownloadSimple, 'Download thread', pick((x) => void downloadThread(x)), 'The whole conversation as a Markdown file')}
                {row('copy', Copy, 'Copy thread ID', pick((x) => void copyId(x)), 'Lets another thread read or message this one')}
                {row('reload', ArrowClockwise, 'Reload thread', pick(reload), 'Reconnect to the thread')}
                {row('reset', ArrowCounterClockwise, 'Reset status', pick((x) => void resetStatus(x)), 'Clear a stuck Working or Needs-you state')}
                {row('why', Question, 'Why is this thread in this state?', pick(setWhyTarget), 'Explains the status and lists the last events')}
                {row('auto-archive', Timer, 'Auto-archive…', pick(setAutoArchiveTarget), 'Archive the thread on its own after a set time')}
                {tokenOptIn && canTakeToken(t) && can('settings.secrets') && (
                  <button key="secrets-env" type="button" role="switch" aria-checked={secretsEnvOn(t)} aria-label="Doppler token in this thread's shell"
                    onClick={pick((x) => void toggleSecretsEnv(x))} style={{ ...z.row, alignItems: 'flex-start' }}>
                    <Key size={z.icon} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                      <span>Doppler token in this thread's shell</span>
                      <span style={{ fontSize: fontVar(z.hint), color: 'var(--color-text-tertiary)' }}>Lets doppler run work here. Applies at the next start.</span>
                    </span>
                    <span style={{ flexShrink: 0, fontSize: fontVar(z.hint), fontWeight: 600, color: secretsEnvOn(t) ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>{secretsEnvOn(t) ? 'On' : 'Off'}</span>
                  </button>
                )}
              </div>
          </>
        )}
        {rule}
        {t.type === 'file'
          ? row('unpin', PushPinSlash, 'Unpin', pick((x) => void archive(x)))
          : row('archive', Archive, 'Archive thread', pick(setArchiveTarget), undefined, { color: 'var(--color-status-red)' })}
      </>
    );
    return { tiles: tilesNode, list: listNode };
  };

  return (
    <>
      {/* One body, three shells: in place (the desktop right column), on a phone the app's shared
          slide-up sheet, on desktop a fly-out at the click. */}
      {inline ? (at && (() => { const b = body(at); return (
        <div role="menu" aria-label="Thread options" data-testid="thread-menu-inline" onKeyDown={moveFocus} style={{ display: 'flex', flexDirection: 'column' }}>{b.tiles}{b.list}</div>
      ); })()) : isMobile ? (
        <Modal open={!!at} sheet title={at?.tab.label} onClose={onClose}>
          {/* A fixed height (owner, 2026-11-13): the sheet never reaches the top of the screen; the tiles
              stay at the top and the rows under them scroll. 78% of the screen less the sheet's header. */}
          {at && (() => { const b = body(at); return (
            <div role="menu" aria-label="Thread options" data-testid="thread-menu-sheet" onKeyDown={moveFocus}
              style={{ display: 'flex', flexDirection: 'column', height: 'calc(78dvh - 96px)', minHeight: 0 }}>
              <div style={{ flexShrink: 0 }}>{b.tiles}</div>
              <div data-testid="thread-menu-list" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>{b.list}</div>
            </div>
          ); })()}
        </Modal>
      ) : at && (() => { const b = body(at); return (
        <FlyOut key={`${at.tab.id}:${at.x}:${at.y}`} label="Thread options" x={at.x} y={at.y} onClose={onClose}>{b.tiles}{b.list}</FlyOut>
      ); })()}

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

      <Modal open={!!whyTarget} sheet title="Why is this thread in this state?" maxWidth={600} onClose={() => setWhyTarget(null)}>
        {whyTarget && <WhyPanel terminalId={whyTarget.id} sessionId={whyTarget.sessionId} onClose={() => setWhyTarget(null)} />}
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
