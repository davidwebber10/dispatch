import { lazy, Suspense } from 'react';
import { AppShell } from './AppShell';
import { Workspace } from './Workspace';
import { GroupedTabBar } from '../panes/GroupedTabBar';
import { GroupedPaneView } from '../panes/GroupedPaneView';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { TabHost } from '../tabs/LazyTabHost';
import { OverseerView } from '../overseer/LazyOverseerView';
import { EmptyWorkspace } from './EmptyWorkspace';
import { Inspector } from '../inspector/Inspector';
import { PanelToggle } from './PanelToggle';
import { AlertBell } from './AlertBell';
import { DispatchWorkPane } from '../overseer/components/DispatchWorkPane';
import { AgentPane } from '../agents/AgentPane';
import { closeAgentPane } from '../agents/closeAgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { PluginDialogs } from '../../plugins/PluginDialogs';
import { ChatMode } from '../endless/LazyChatMode';
import { Spinner } from '../common/Spinner';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { PluginView, Slot } from '../../plugins/PluginView';
import { CommandPalette } from '../CommandPalette';
import { isPluginView } from '../../plugins/registry';
import { useProjects } from '../../stores/projects';
import { useTabs, isDispatchTab } from '../../stores/tabs';
import { useAgents } from '../../stores/agents';
import { useLedgerCard } from '../../stores/ledgerCard';
import { openDecisionCount } from '../overseer/ledger';
import { useAgentUI } from '../../stores/agentUI';
import { useReconnect } from '../../stores/reconnect';
import { useSettings } from '../../stores/settings';
import { useGroups } from '../panes/store';
import { useUI } from '../../stores/ui';
import { can, pluginViewAllowed } from '../../lib/profile';
import { AllAgentsView } from '../agents/AllAgentsView';
import { usesOsLook } from '../../lib/hostContext';
import { useActiveTheme } from '../../themes/apply';
import { useNavigation } from '../../stores/navigation';
const OsTopBarActions = lazy(() => import('./os').then((m) => ({ default: m.OsTopBarActions })));

// The desktop shell: the icon rail and the view it shows (engineering program 2026-11-09, W2-E).
// App.tsx loads this module only at a desktop width, and the phone shell (mobile/MobileApp) only
// at a phone width, so neither downloads the other's code. The JSX below moved here from App.tsx
// unchanged, but for the views that are now loaded on demand (Settings, Analytics, the Control Plane).

const AnalyticsView = lazy(() => import('../analytics/AnalyticsView').then((m) => ({ default: m.AnalyticsView })));
const SettingsView = lazy(() => import('../settings/SettingsView').then((m) => ({ default: m.SettingsView })));

// Centred in the pane at the same footprint the loaded view will occupy, so
// nothing jumps when the chunk (Recharts is ~120kB gzipped) finishes downloading.
const viewFallback = (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%' }}>
    <Spinner size={24} />
  </div>
);

export function DesktopShell() {
  const activeTerminalId = useTabs((s) => s.activeTabId);
  const selectTab = (id: string) => { useAgentUI.getState().blur(); useTabs.getState().setActiveTab(id); };
  const dispatchProject = (projectId: string) => { useAgentUI.getState().blur(); useTabs.getState().openDispatch(projectId); };
  const activeId = useProjects((s) => s.activeId);
  // The Control Plane's open decisions, for the collapsed details toggle (pinned card spec, Unit 7).
  const openDecisions = useLedgerCard((s) => openDecisionCount((activeId && s.byProject[activeId]?.card) || null));
  // A view the profile hides (a link, a remembered view, a plugin screen) shows the workspace instead.
  const rawView = useUI((s) => s.view);
  const view = (rawView === 'analytics' && !can('analytics')) || (rawView === 'chat' && !can('endless')) || (rawView === 'automations' && !can('automations')) || (isPluginView(rawView) && !pluginViewAllowed(rawView)) ? 'workspace' : rawView;
  const agentFocused = useAgentUI((s) => s.focused);
  const agentSelected = useAgents((s) => s.selectedId);
  const editing = useAgentUI((s) => s.editing);
  const multiPane = useSettings((s) => s.multiPane);
  // The group the active tab belongs to (if any). Subscribing keeps the operator
  // main reactive: merging/unmerging the active tab swaps single ⇄ grouped view.
  const activeGroupId = useGroups((s) => (activeTerminalId ? s.tabGroup[activeTerminalId] : undefined));
  const reconnectGen = useReconnect((s) => s.gen);
  const showAgent = agentFocused && !!agentSelected;
  const os = usesOsLook();
  const themeKind = useActiveTheme((s) => s.theme.kind);
  const projectSidebar = (
    <ProjectSidebar
      onSelectTab={selectTab}
      onSelectAgent={(id) => useAgentUI.getState().selectAgent(id)}
      onNewAgent={(pid) => useAgentUI.getState().openNew(pid)}
      onDispatch={dispatchProject}
    />
  );

  return (
    <>
      <Slot name="app.overlay" />
      <CommandPalette />
      {/* Hosted (or the business preview): the Threads | Projects list moves into the OS rail. */}
      <AppShell rail={os ? projectSidebar : undefined}>
        {/* One boundary per view: a render error leaves the shell (the icon rail) on screen, and
            a change of view starts clean (the key). */}
        <ErrorBoundary key={view} scope={`${view} view`}>
        {view === 'settings'
          ? <Suspense fallback={viewFallback}><SettingsView /></Suspense>
          : isPluginView(view)
          ? <PluginView viewKey={view} />
          : view === 'chat'
          ? <ChatMode />
          : view === 'automations'
          ? <AutomationsView />
          : view === 'analytics'
          ? <Suspense fallback={viewFallback}><AnalyticsView /></Suspense>
          : (
            <Workspace
              sidebar={os ? null : projectSidebar}
              main={
                showAgent
                  ? <AgentPane onClose={closeAgentPane} />
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                      {/* The panel toggles flank the tab strip — the old TopBar's
                          top-left / top-right positions, one row down. */}
                      <div style={{ display: 'flex', flexShrink: 0 }}>
                        {!os && <PanelToggle side="left" />}
                        {/* Own bar styling too: GroupedTabBar returns null with no tabs,
                            and the strip must stay a continuous 44px bar even then. */}
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: os ? 'var(--color-base)' : 'var(--color-pane)', borderBottom: '1px solid var(--color-border)', minHeight: os ? 56 : undefined }}>
                          <GroupedTabBar onSelect={() => useAgentUI.getState().blur()} />
                        </div>
                        <PanelToggle side="right" count={isDispatchTab(activeTerminalId) ? openDecisions : 0} />
                        {os && <Suspense fallback={null}><OsTopBarActions before={activeTerminalId && !isDispatchTab(activeTerminalId) ? <AlertBell terminalId={activeTerminalId} bar /> : null} kind={themeKind} onFlipTheme={() => useSettings.getState().setTheme(themeKind === 'dark' ? 'os-light' : 'os-dark')} onAccount={() => useNavigation.getState().navigate({ view: 'settings', section: 'accounts' })} /></Suspense>}
                      </div>
                      {activeTerminalId
                        ? (isDispatchTab(activeTerminalId)
                            // Dispatch coordinator opens as a tab — wrap it so its height:100%
                            // root flexes within the space left below the tab strip.
                            ? <div style={{ flex: 1, minHeight: 0, display: 'flex' }}><OverseerView key={activeTerminalId} /></div>
                            : (multiPane && activeGroupId
                                ? <GroupedPaneView key={`${activeGroupId}:${reconnectGen}`} groupId={activeGroupId} />
                                : <TabHost key={`${activeTerminalId}:${reconnectGen}`} terminalId={activeTerminalId} />))
                        : <EmptyWorkspace onSelectTab={selectTab} />}
                    </div>
                  )
              }
              inspector={<Inspector projectId={activeId} terminalId={activeTerminalId} onOpenFile={selectTab} detailsSlot={isDispatchTab(activeTerminalId) ? <DispatchWorkPane /> : undefined} />}
            />
          )}
        </ErrorBoundary>
      </AppShell>
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => useAgentUI.getState().selectAgent(id)} />}
      <PluginDialogs />
    </>
  );
}

/** Every automation across the projects (the list the phone shows); a row opens it in its project. */
function AutomationsView() {
  const open = (projectId: string, scheduleId: string) => {
    useProjects.getState().setActive(projectId);
    useUI.getState().setView('workspace');
    useAgentUI.getState().selectAgent(scheduleId);
  };
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--color-base)' }}>
      <div style={{ display: 'flex', alignItems: 'center', height: 56, padding: '0 20px', flexShrink: 0, borderBottom: '1px solid var(--color-border)', font: '600 16px var(--font-sans)', color: 'var(--color-text-primary)' }}>Automations</div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', maxWidth: 900, width: '100%', margin: '0 auto' }}>
        <AllAgentsView onOpenAgent={open} />
      </div>
    </div>
  );
}
