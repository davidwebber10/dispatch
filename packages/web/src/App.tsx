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
import { useTabs, isDispatchTab, findTerminal } from './stores/tabs';
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
import { useViewing } from './stores/viewing';
import { useUI } from './stores/ui';
import { parseThreadPath } from './lib/deepLink';

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
    void useTabs.getState().hydrate().then(() => {
      if (window.innerWidth <= 768) return; // MobileApp restores /p/… URLs natively
      const deep = parseThreadPath(location.pathname);
      if (deep) { history.replaceState({}, '', '/'); useUI.getState().requestOpenThread(deep); }
    });
    void useAuth.getState().load();
    void useUpdate.getState().load();
    void useHost.getState().load();
    void useAgents.getState().loadSchedules();
    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string; terminalId?: string } | null;
      if (d?.type === 'open-thread' && d.sessionId && d.terminalId) {
        useUI.getState().requestOpenThread({ sessionId: d.sessionId, terminalId: d.terminalId });
      }
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
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
      },
    });
    sockRef.current = sock;
    return () => { sock.close(); sockRef.current = null; navigator.serviceWorker?.removeEventListener('message', onSwMessage); };
  }, []);

  useEffect(() => {
    const report = () => {
      if (!useSettings.getState().pushEnabled) return;
      const fg = document.visibilityState === 'visible' && document.hasFocus();
      void import('./lib/push').then((m) => m.reportPresence(fg, fg ? useViewing.getState().id : null)).catch(() => {});
    };
    report();
    const unsub = useViewing.subscribe(report); // re-report when the viewed thread changes
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    const t = setInterval(report, 60_000); // keep genuinely-present devices fresh past the server's 90s TTL
    return () => { unsub(); document.removeEventListener('visibilitychange', report); window.removeEventListener('focus', report); window.removeEventListener('blur', report); clearInterval(t); };
  }, []);

  // Desktop: the active tab IS the viewed thread. Mobile: MobileApp owns this
  // (its level-2 leaf state), so don't fight it from here.
  useEffect(() => {
    if (isMobile) return;
    useViewing.getState().set(activeTerminalId && !isDispatchTab(activeTerminalId) ? activeTerminalId : null);
  }, [activeTerminalId, isMobile]);

  // Desktop consumer of the open-thread intent (mobile's lives in MobileApp).
  const pendingThread = useUI((s) => s.pendingOpenThread);
  useEffect(() => {
    if (!pendingThread || isMobile) return;
    const { sessionId, terminalId } = pendingThread;
    useUI.getState().clearOpenThread();
    void (async () => {
      try { await useTabs.getState().loadTabs(sessionId); } catch { return; } // project gone → open normally
      if (!findTerminal(useTabs.getState().byProject, terminalId)) return;    // thread gone → open normally
      useProjects.getState().setActive(sessionId);
      useTabs.getState().setActiveTab(terminalId);
    })();
  }, [pendingThread, isMobile]);

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
