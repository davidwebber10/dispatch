import { useEffect, useState } from 'react';
import { ChartBar, ChatCircleDots, Eye, Gear } from '@phosphor-icons/react';
import { PROJECTS_ICON, THREADS_ICON } from '../common/viewIcons';
import { useProjectsView } from '../../stores/projectsView';
import type { Icon } from '@phosphor-icons/react';
import { BrandSwitcher } from './BrandSwitcher';
import { useShownStatus } from '../../stores/connection';
import { useServers, currentLabel } from '../../stores/servers';
import { useUI, type View } from '../../stores/ui';
import { UsageChip } from './UsageChip';
import { useTabs, isDispatchTab, findTerminal } from '../../stores/tabs';
import { useAccounts, threadAccount } from '../../stores/accounts';
import { UpdateDot } from '../update/UpdateDot';
import { usePluginViews, usePluginRegistry } from '../../plugins/registry';
import { can, pluginViewAllowed, type Feature } from '../../lib/profile';
import { hostCopy } from '../../lib/hostCopy';
import { pluginIcon } from '../../plugins/sdk';

const CONN = {
  open:       { color: 'var(--color-accent)', label: 'Connected' },
  connecting: { color: 'var(--color-status-yellow)', label: hostCopy('conn.connecting', 'Connecting…') },
  reconnecting: { color: 'var(--color-status-yellow)', label: hostCopy('conn.reconnecting', 'Reconnecting…') },
  closed:     { color: 'var(--color-status-red)', label: hostCopy('conn.closed', 'Disconnected') },
} as const;

function RailItem({ icon: I, label, active, onClick, title, badge = 0, dot = false }: {
  icon: Icon; label: string; active: boolean; onClick: () => void; title: string; badge?: number;
  /** A plain dot (no count) at the icon's corner: Settings while an update waits. */
  dot?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" title={title} aria-pressed={active} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 52, height: 44, flexShrink: 0, borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
        position: 'relative', padding: 0,
        background: active ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : hover ? 'var(--color-elevated)' : 'transparent',
        color: active ? 'var(--color-accent)' : 'var(--color-text-secondary)',
      }}>
      <span style={{ position: 'relative', display: 'flex' }}>
        <I size={18} weight={active ? 'fill' : 'regular'} />
        {dot && <UpdateDot style={{ top: -3, right: -5 }} />}
      </span>
      <span style={{ font: '400 8.5px var(--font-sans)', letterSpacing: '0.01em' }}>{label}</span>
      {badge > 0 && (
        <span aria-label={`${badge} new`} style={{ position: 'absolute', top: 4, right: 7, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '700 10px var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {/* Active marker: a short bar hugging the rail's left edge, like an editor activity bar. */}
      <span style={{
        position: 'absolute', left: -6, top: '50%', transform: 'translateY(-50%)',
        width: 3, height: 18, borderRadius: 'var(--radius-xs)', background: active ? 'var(--color-accent)' : 'transparent',
      }} />
    </button>
  );
}

const NAV: { view: View; label: string; icon: Icon; feature?: Feature }[] = [
  { view: 'workspace', label: 'Threads', icon: THREADS_ICON },
  { view: 'chat', label: 'Chat', icon: ChatCircleDots, feature: 'endless' },
  { view: 'analytics', label: 'Analytics', icon: ChartBar, feature: 'analytics' },
];

/**
 * The app's primary navigation: a full-height icon rail on the far left
 * (design: "Dispatch Layout"). Replaces the old TopBar — the view switch, server
 * switcher, connection status, panel toggles, and settings all live here now.
 */
export function IconRail() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const status = useShownStatus();
  const servers = useServers((s) => s.servers);
  const conn = CONN[status];
  // The server's name under the dot names the machine; a hosted workspace says "Workspace".
  const serverLabel = hostCopy('conn.serverLabel', currentLabel(servers, window.location.origin));
  // Plugin screens sit after the built-in ones (docs/superpowers/specs/2026-11-07-plugins-design.md).
  const pluginViews = usePluginViews();
  // The first item is named after the Projects ⇄ Threads switch (2026-11-07).
  const projectsView = useProjectsView((s) => s.view);
  const badges = usePluginRegistry((s) => s.badges);
  // The open thread's account (2026-11-09): its usage ring is marked "This thread".
  const activeId = useTabs((s) => s.activeTabId);
  const activeTab = useTabs((s) => (activeId && !isDispatchTab(activeId) ? findTerminal(s.byProject, activeId) : undefined));
  const accountsView = useAccounts((s) => s.view);
  useEffect(() => { if (activeTab) void useAccounts.getState().load(); }, [activeTab]);
  const usageCurrent = view === 'workspace' && activeTab
    ? { provider: activeTab.type, accountId: threadAccount(accountsView, activeTab)?.id ?? 'cli' } : null;

  // ⌘, — the platform-standard preferences shortcut, now that Settings is a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        useUI.getState().setView('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav aria-label="Primary" style={{
      width: 64, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '10px 0 8px', gap: 4, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)',
    }}>
      <div style={{ marginBottom: 10 }}><BrandSwitcher /></div>
      {NAV.filter((n) => !n.feature || can(n.feature)).map((n) => n.view === 'workspace' ? { ...n, label: projectsView === 'threads' ? 'Threads' : 'Projects', icon: projectsView === 'threads' ? THREADS_ICON : PROJECTS_ICON } : n).map((n) => (
        <RailItem key={n.view} icon={n.icon} label={n.label} title={n.label}
          active={view === n.view} onClick={() => setView(n.view)} />
      ))}
      {pluginViews.filter((v) => pluginViewAllowed(v.key)).map((v) => (
        <RailItem key={v.key} icon={pluginIcon(v.icon)} label={v.label} title={v.label}
          active={view === v.key} onClick={() => setView(v.key as View)} badge={badges[v.key] ?? 0} />
      ))}
      <div style={{ flex: 1 }} />
      {/* Account usage (#127): above the connection dot, hidden until a provider reports. */}
      <UsageChip variant="rail" current={usageCurrent} />
      <div title={conn.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '6px 0 2px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', background: conn.color,
          boxShadow: status === 'open' ? 'var(--shadow-glow)' : undefined,
          animation: status !== 'closed' ? 'dispatchConnPulse 2s ease-in-out infinite' : undefined,
        }} />
        <span style={{ font: '500 7.5px var(--font-mono)', letterSpacing: '0.04em', color: 'var(--color-text-tertiary)', textTransform: 'uppercase' }}>
          {serverLabel}
        </span>
      </div>
      <RailItem icon={Gear} label="Settings" title="Settings (⌘,)" dot
        active={view === 'settings'} onClick={() => setView('settings')} />
    </nav>
  );
}
