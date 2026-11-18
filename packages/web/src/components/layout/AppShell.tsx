import { useEffect, type ReactNode } from 'react';
import { IconRail } from './IconRail';
import { UsageBanner } from './UsageBanner';
import { lazy, Suspense } from 'react';
// Loaded on demand: a local install never downloads the OS shell.
const OsLeftRail = lazy(() => import('./os').then((m) => ({ default: m.OsLeftRail })));
import { usesOsLook } from '../../lib/hostContext';
import { usePluginViews } from '../../plugins/registry';
import { pluginIcon } from '../../plugins/sdk';
import { useUI, type View } from '../../stores/ui';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useDispatchName } from '../../stores/settings';
import { can, pluginViewAllowed } from '../../lib/profile';
import { useNavigation } from '../../stores/navigation';
import { useOsConnections } from '../../stores/osConnections';
import { THREADS_ICON } from '../common/viewIcons';
import { ChartBar, ChatCircleDots, Network, Timer, PlugsConnected } from '@phosphor-icons/react';

// A hosted workspace (and the business preview) wears the Polywood OS shell: OsLeftRail in place of the
// icon rail, holding `rail` (the Threads | Projects list). A local install keeps the icon rail.
export function AppShell({ children, rail }: { children: ReactNode; rail?: ReactNode }) {
  // The OS rail's entries, from the profile feature map (the rail's lazy chunk imports no app store).
  const view = useUI((s) => s.view);
  const activeProject = useProjects((s) => s.activeId);
  const dispatchName = useDispatchName();
  const pluginViews = usePluginViews();
  const os = usesOsLook();
  const osHosted = useOsConnections((s) => !!s.state?.hosted);
  useEffect(() => { if (os) void useOsConnections.getState().load(); }, [os]);
  const go = (v: View) => useUI.getState().setView(v);
  const nav = os ? [
    { key: 'threads', icon: THREADS_ICON, label: 'Threads', active: view === 'workspace', onSelect: () => go('workspace') },
    ...(can('endless') ? [{ key: 'chat', icon: ChatCircleDots, label: 'Chat', active: view === 'chat', onSelect: () => go('chat') }] : []),
    ...(can('control-plane') && activeProject ? [{ key: 'control', icon: Network, label: dispatchName, active: false, onSelect: () => { go('workspace'); useTabs.getState().openDispatch(activeProject); } }] : []),
    ...(can('analytics') ? [{ key: 'analytics', icon: ChartBar, label: 'Analytics', active: view === 'analytics', onSelect: () => go('analytics') }] : []),
    // Automations across every project (the list the phone shows), then the Inbox and the other plugin screens.
    ...(can('automations') ? [{ key: 'automations', icon: Timer, label: 'Automations', active: view === 'automations', onSelect: () => go('automations') }] : []),
    ...pluginViews.filter((v) => pluginViewAllowed(v.key)).map((v) => ({ key: v.key, icon: pluginIcon(v.icon), label: v.label, active: view === v.key, onSelect: () => go(v.key as View) })),
    // Company connections (hosted only): Settings > Accounts, where the panel and its Connect cards live.
    ...(osHosted ? [{ key: 'connections', icon: PlugsConnected, label: 'Connections', active: false, onSelect: () => useNavigation.getState().navigate({ view: 'settings', section: 'accounts' }) }] : []),
  ] : [];
  return (
    <div style={{ display: 'flex', height: '100%', background: 'var(--color-base)' }}>
      {os ? <Suspense fallback={<div style={{ width: 288, flexShrink: 0, background: 'var(--color-pane)', borderRight: '1px solid var(--color-border)' }} />}><OsLeftRail sidebar={rail} nav={nav} settingsActive={view === 'settings'} onSettings={() => go('settings')} /></Suspense> : <IconRail />}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Agents paused on a usage limit (#127): a strip above every view, so it is seen from anywhere. */}
        <UsageBanner />
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
}
