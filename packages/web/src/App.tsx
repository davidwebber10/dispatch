import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Workspace } from './components/layout/Workspace';
import { GroupedTabBar } from './components/panes/GroupedTabBar';
import { GroupedPaneView } from './components/panes/GroupedPaneView';
import { ProjectSidebar } from './components/sidebar/ProjectSidebar';
import { TabHost } from './components/tabs/TabHost';
import { OverseerView } from './components/overseer/OverseerView';
import { EmptyWorkspace } from './components/layout/EmptyWorkspace';
import { Inspector } from './components/inspector/Inspector';
import { DispatchWorkPane } from './components/overseer/components/DispatchWorkPane';
import { AgentPane } from './components/agents/AgentPane';
import { EditAgentModal } from './components/agents/EditAgentModal';
import { AuthBanner } from './components/auth/AuthBanner';
import { UpdateModal } from './components/update/UpdateModal';
import { MobileApp } from './components/mobile/MobileApp';
import { SetupWizard } from './components/setup/SetupWizard';
import { useIsMobile } from './hooks/useIsMobile';
import { useTabCycleShortcut } from './hooks/useTabCycleShortcut';
import { createEventsSocket } from './api/events-socket';
import { useConnection } from './stores/connection';
import { useProjects } from './stores/projects';
import { useTabs, isDispatchTab } from './stores/tabs';
import { useActivity } from './stores/activity';
import { useThreadStatus } from './stores/threadStatus';
import { useAuth } from './stores/auth';
import { useUpdate } from './stores/update';
import { useHost } from './stores/host';
import { useAgents } from './stores/agents';
import { useAgentUI } from './stores/agentUI';
import { useReconnect } from './stores/reconnect';
import { useResume } from './hooks/useResume';
import { useSettings } from './stores/settings';
import { useServers } from './stores/servers';
import { useGroups } from './components/panes/store';

function maybeNotify(sessionId: string) {
  const { notify, pushEnabled } = useSettings.getState();
  if (pushEnabled) return; // server push handles it (this tab counts as away)
  if (!notify || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const proj = useProjects.getState().sessions.find((x) => x.id === sessionId);
  try { new Notification('Dispatch — input needed', { body: proj?.name ?? 'A session needs your input', icon: '/icons/icon-192.png' }); } catch { /* ignore */ }
}

export default function App() {
  const activeTerminalId = useTabs((s) => s.activeTabId);
  const selectTab = (id: string) => { useAgentUI.getState().blur(); useTabs.getState().setActiveTab(id); };
  const dispatchProject = (projectId: string) => { useAgentUI.getState().blur(); useTabs.getState().openDispatch(projectId); };
  const activeId = useProjects((s) => s.activeId);
  const isMobile = useIsMobile();
  useTabCycleShortcut(); // Ctrl+Tab / Ctrl+Shift+Tab cycle open tabs
  const agentFocused = useAgentUI((s) => s.focused);
  const agentSelected = useAgents((s) => s.selectedId);
  const editing = useAgentUI((s) => s.editing);
  const multiPane = useSettings((s) => s.multiPane);
  // The group the active tab belongs to (if any). Subscribing keeps the operator
  // main reactive: merging/unmerging the active tab swaps single ⇄ grouped view.
  const activeGroupId = useGroups((s) => (activeTerminalId ? s.tabGroup[activeTerminalId] : undefined));
  const reconnectGen = useReconnect((s) => s.gen);
  const sockRef = useRef<{ close(): void; reconnect(): void } | null>(null);

  useEffect(() => {
    void useProjects.getState().load();
    void useServers.getState().load();
    void useTabs.getState().hydrate();
    void useAuth.getState().load();
    void useUpdate.getState().load();
    void useHost.getState().load();
    void useAgents.getState().loadSchedules();
    const sock = createEventsSocket({
      onStatus: (s) => useConnection.getState().setStatus(s),
      onEvent: (e) => {
        useProjects.getState().applyEvent(e);
        useTabs.getState().applyEvent(e);
        useActivity.getState().applyEvent(e);
        useThreadStatus.getState().applyEvent(e);
        useAuth.getState().applyEvent(e);
        useUpdate.getState().applyEvent(e);
        useAgents.getState().applyEvent(e);
        if (e.type === 'session:status' && e.status === 'needs_input' && typeof e.sessionId === 'string') maybeNotify(e.sessionId);
      },
    });
    sockRef.current = sock;
    return () => { sock.close(); sockRef.current = null; };
  }, []);

  useEffect(() => {
    const report = () => { if (useSettings.getState().pushEnabled) void import('./lib/push').then((m) => m.reportPresence(document.visibilityState === 'visible' && document.hasFocus())).catch(() => {}); };
    report();
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    return () => { document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); };
  }, []);

  // Returning from the background: re-establish the events socket and remount
  // every terminal (which iOS may have silently killed) so the UI is live
  // again without the user having to back out of the view.
  useResume(() => {
    sockRef.current?.reconnect();
    useReconnect.getState().bump();
  });

  // Browser close / refresh with unsaved file edits — the tab-close guard can't see this one.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (Object.keys(useTabs.getState().dirtyTabs).length === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (isMobile) {
    return (<><SetupWizard /><AuthBanner /><UpdateModal /><MobileApp /></>);
  }

  const showAgent = agentFocused && !!agentSelected;

  return (
    <>
      <SetupWizard />
      <AuthBanner />
      <UpdateModal />
      <AppShell>
        <Workspace
          sidebar={
            <ProjectSidebar
              onSelectTab={selectTab}
              onSelectAgent={(id) => useAgentUI.getState().selectAgent(id)}
              onNewAgent={(pid) => useAgentUI.getState().openNew(pid)}
              onDispatch={dispatchProject}
            />}
          main={
            showAgent
              ? <AgentPane />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                  <GroupedTabBar onSelect={() => useAgentUI.getState().blur()} />
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
      </AppShell>
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => useAgentUI.getState().selectAgent(id)} />}
    </>
  );
}
