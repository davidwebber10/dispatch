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
import { AccountSwitchModal } from '../common/AccountSwitchModal';
import { Modal } from '../common/Modal';
import { DetailsPane } from '../inspector/DetailsPane';
import { WhyPanel } from '../inspector/WhyPanel';
import { useIsMobile } from '../../hooks/useIsMobile';
import { pluginIcon } from '../../plugins/sdk';
import {
  PencilSimple, GitBranch, UserSwitch, Bell, BellSlash, Info, Copy, ArrowClockwise, ArrowCounterClockwise,
  Timer, Archive, PushPinSlash, CaretDown, CaretRight, Key, Question,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';

/** Harnesses whose CLI can fork a session (core providers' buildBranchCommand). OpenCode
 *  runs only over ACP, which has no fork, so it is left out. */
const BRANCHABLE: string[] = ['claude-code', 'codex', 'grok'];

export type ThreadMenuAt = { tab: Terminal; x: number; y: number };
/** A plugin row the caller adds (the phone's thread header: plugins' right-column tabs). */
export type ThreadMenuPluginRow = { key: string; label: string; icon: Icon; onPick: (tab: Terminal) => void; badge?: MenuBadge<InspectorTabCtx> };

/** One body, two shells (2026-11-07): the phone's slide-up sheet and the desktop's fly-out show the
 *  same groups; only the sizes differ. `sheet` is finger-sized, `popover` is mouse-sized. */
type Density = 'sheet' | 'popover';
const baseRow: React.CSSProperties = { display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: 'var(--color-text-primary)', cursor: 'pointer' };
const SIZES: Record<Density, { row: React.CSSProperties; icon: number; tileIcon: number; tile: React.CSSProperties; caption: React.CSSProperties; hint: number; gap: number; pad: string }> = {
  sheet: {
    row: { ...baseRow, gap: 12, padding: '11px 12px', fontSize: 15, borderRadius: 'var(--radius-md)' },
    icon: 20, tileIcon: 22, hint: 12.5, gap: 8, pad: '2px 4px 6px',
    tile: { height: 72, fontSize: 12, borderRadius: 'var(--radius-lg)' },
    caption: { padding: '10px 12px 2px', fontSize: 11.5 },
  },
  popover: {
    row: { ...baseRow, gap: 10, padding: '7px 10px', fontSize: 13, borderRadius: 'var(--radius-sm)' },
    icon: 16, tileIcon: 18, hint: 11.5, gap: 6, pad: '2px 2px 4px',
    tile: { height: 58, fontSize: 11.5, borderRadius: 'var(--radius-md)' },
    caption: { padding: '8px 10px 2px', fontSize: 10.5 },
  },
};
/** A quick-action tile at the top of the menu: icon above a short label. */
const tileBase: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, minWidth: 0, padding: '0 4px',
  background: 'var(--color-elevated)', border: '1px solid var(--color-border)',
  color: 'var(--color-text-primary)', fontWeight: 500, cursor: 'pointer',
};
/** A group's small caption ("View", "Plugins"). */
const captionBase: React.CSSProperties = { fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--color-text-tertiary)' };
const rule = <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '6px 6px' }} />;
/** The desktop fly-out's width and its distance from the viewport's edges. */
const FLYOUT_W = 320;
const EDGE = 8;

/** Arrow keys walk the menu's buttons (tiles included) and wrap; Home and End jump. Enter is the
 *  button's own. */
function moveFocus(e: React.KeyboardEvent<HTMLElement>) {
  const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
  if (!step && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled])'));
  if (items.length === 0) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
    : at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}

/** The desktop shell: a fly-out at the click, kept inside the viewport (it slides up, or in,
 *  when there is no room below or to the right), with its own scroll. Escape or a click outside
 *  closes it. */
function FlyOut({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const left = Math.max(EDGE, Math.min(x, window.innerWidth - EDGE - FLYOUT_W));
  const [top, setTop] = useState(y);
  // Measured after every render, not only on open: More grows the fly-out, and it must not grow off
  // the bottom. setTop with an unchanged value is a no-op, so this settles.
  useLayoutEffect(() => {
    const h = ref.current?.getBoundingClientRect().height ?? 0;
    const room = window.innerHeight - EDGE;
    // Slide up only as far as needed, so the row under the pointer (More) moves as little as it can.
    setTop(Math.max(EDGE, Math.min(y, room - h)));
  });
  // Callers pass a fresh onClose each render; read it through a ref so a parent's re-render does
  // not pull the focus back to the first item.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return createPortal(
    <>
      <div data-testid="thread-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} style={{ position: 'fixed', inset: 0, zIndex: 300 }} />
      <div ref={ref} role="menu" aria-label="Thread options" onKeyDown={moveFocus}
        style={{
          position: 'fixed', top, left, zIndex: 301, width: FLYOUT_W, maxHeight: `calc(100vh - ${EDGE * 2}px)`, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
          background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-lg)',
          padding: 6, boxShadow: '0 20px 50px -20px var(--color-shadow-strong)',
        }}>
        {children}
      </div>
    </>,
    document.body,
  );
}

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
  // The "Why is this thread in this state?" panel (W2-G).
  const [whyTarget, setWhyTarget] = useState<Terminal | null>(null);
  const isMobile = useIsMobile();
  // Items plugins added (docs/superpowers/specs/2026-11-07-plugins-design.md, section 2.3).
  const pluginItems = useContributions('threadMenu');
  // The Doppler token switch exists only when the owner chose "only threads that I turn on" (W1-C).
  const tokenOptIn = useSecrets((s) => !!s.status?.connected && s.status?.tokenScope === 'opted-in');
  const menuOpen = !!at;
  useEffect(() => { if (menuOpen) void useSecrets.getState().loadScope(); }, [menuOpen]);
  // The phone sheet's More disclosure starts closed each time the sheet opens.
  const [moreOpen, setMoreOpen] = useState(false);
  const [openedFor, setOpenedFor] = useState<ThreadMenuAt | null>(at);
  if (openedFor !== at) { setOpenedFor(at); if (moreOpen) setMoreOpen(false); }

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

  /** A menu row: icon, label, and an optional plain-words line under it. */
  const row = (key: string, Glyph: Icon, label: string, onClick: () => void, hint?: string, extra: React.CSSProperties = {}, trailing?: React.ReactNode) => {
    const hintId = hint ? `thread-menu-hint-${key}` : undefined;
    return (
      <button key={key} type="button" onClick={onClick} aria-label={hint ? label : undefined} aria-describedby={hintId} style={{ ...z.row, alignItems: hint ? 'flex-start' : 'center', ...extra }}>
        <Glyph size={z.icon} style={{ flexShrink: 0, marginTop: hint ? 1 : 0 }} />
        {hint ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <span>{label}</span>
            <span id={hintId} style={{ fontSize: z.hint, color: 'var(--color-text-tertiary)' }}>{hint}</span>
          </span>
        ) : label}
        {trailing}
      </button>
    );
  };

  /** The menu's groups (2026-11-07), the same in both shells: it was 15 equal-weight rows with no way
   *  to tell what mattered. The phone sheet got these first; the desktop fly-out shows them too. */
  const body = (at: ThreadMenuAt) => {
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
      ...(pluginRows ?? []).map((p) => row(`tab-${p.key}`, p.icon, p.label, pick(p.onPick), undefined, {}, p.badge ? <MenuBadgeCount badge={p.badge} ctx={{ terminalId: t.id, sessionId: t.sessionId ?? null }} /> : undefined)),
      ...pluginItems.filter((p) => !p.when || p.when({ tab: t }))
        .map((p) => row(`item-${p.plugin}-${p.id}`, pluginIcon(p.icon), p.label, pick((x) => p.onPick({ tab: x })), undefined, {}, p.badge ? <MenuBadgeCount badge={p.badge} ctx={{ tab: t }} /> : undefined)),
    ];
    // Desktop shows Thread details in its right-hand panel; a phone has no panel.
    const details = isMobile && isThread(t);
    const hasView = !!leadView || details;
    const caption = { ...captionBase, ...z.caption };
    return (
      <>
        <div role="group" aria-label="Quick actions" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: z.gap, padding: z.pad }}>
          {tiles.map((x) => (
            <button key={x.key} type="button" aria-label={x.name} aria-pressed={x.pressed} onClick={x.onClick}
              style={{ ...tileBase, ...z.tile, ...(x.pressed ? { color: 'var(--color-accent)', borderColor: 'var(--color-accent)' } : {}) }}>
              <x.Glyph size={z.tileIcon} weight={x.pressed ? 'fill' : 'regular'} />
              <span style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
            </button>
          ))}
        </div>
        {hasView && (
          <div role="group" aria-label="View" style={{ display: 'flex', flexDirection: 'column' }}>
            <div aria-hidden style={caption}>View</div>
            {leadView?.(onClose, z.row)}
            {details && row('details', Info, 'Thread details', pick(setDetailsTarget))}
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
              style={{ ...z.row, color: 'var(--color-text-secondary)' }}>
              {moreOpen ? <CaretDown size={z.icon} /> : <CaretRight size={z.icon} />}More
            </button>
            {moreOpen && (
              <div id="thread-menu-more" style={{ display: 'flex', flexDirection: 'column' }}>
                {row('copy', Copy, 'Copy thread ID', pick((x) => void copyId(x)), 'Lets another thread read or message this one')}
                {row('reload', ArrowClockwise, 'Reload thread', pick(reload), 'Reconnect to the thread')}
                {row('reset', ArrowCounterClockwise, 'Reset status', pick((x) => void resetStatus(x)), 'Clear a stuck Working or Needs-you state')}
                {row('why', Question, 'Why is this thread in this state?', pick(setWhyTarget), 'Explains the status and lists the last events')}
                {row('auto-archive', Timer, 'Auto-archive…', pick(setAutoArchiveTarget), 'Archive the thread on its own after a set time')}
                {tokenOptIn && canTakeToken(t) && (
                  <button key="secrets-env" type="button" role="switch" aria-checked={secretsEnvOn(t)} aria-label="Doppler token in this thread's shell"
                    onClick={pick((x) => void toggleSecretsEnv(x))} style={{ ...z.row, alignItems: 'flex-start' }}>
                    <Key size={z.icon} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                      <span>Doppler token in this thread's shell</span>
                      <span style={{ fontSize: z.hint, color: 'var(--color-text-tertiary)' }}>Lets doppler run work here. Applies at the next start.</span>
                    </span>
                    <span style={{ flexShrink: 0, fontSize: z.hint, fontWeight: 600, color: secretsEnvOn(t) ? 'var(--color-accent)' : 'var(--color-text-tertiary)' }}>{secretsEnvOn(t) ? 'On' : 'Off'}</span>
                  </button>
                )}
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
      {/* One body, two shells: on a phone the app's shared slide-up sheet, on desktop a fly-out at the click. */}
      {isMobile ? (
        <Modal open={!!at} sheet title={at?.tab.label} onClose={onClose}>
          {at && <div role="menu" aria-label="Thread options" onKeyDown={moveFocus} style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>{body(at)}</div>}
        </Modal>
      ) : at && (
        <FlyOut key={`${at.tab.id}:${at.x}:${at.y}`} x={at.x} y={at.y} onClose={onClose}>{body(at)}</FlyOut>
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
