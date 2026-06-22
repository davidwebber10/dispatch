import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Workspace } from './components/layout/Workspace';
import { TabBar } from './components/layout/TabBar';
import { ProjectSidebar } from './components/sidebar/ProjectSidebar';
import { TabHost } from './components/tabs/TabHost';
import { EmptyWorkspace } from './components/layout/EmptyWorkspace';
import { Inspector } from './components/inspector/Inspector';
import { AgentPane } from './components/agents/AgentPane';
import { EditAgentModal } from './components/agents/EditAgentModal';
import { AuthBanner } from './components/auth/AuthBanner';
import { MobileApp } from './components/mobile/MobileApp';
import { useIsMobile } from './hooks/useIsMobile';
import { createEventsSocket } from './api/events-socket';
import { useConnection } from './stores/connection';
import { useProjects } from './stores/projects';
import { useTabs } from './stores/tabs';
import { useActivity } from './stores/activity';
import { useThreadStatus } from './stores/threadStatus';
import { usePrompts } from './stores/prompts';
import { useAuth } from './stores/auth';
import { useAgents } from './stores/agents';
import { useAgentUI } from './stores/agentUI';
import { useReconnect } from './stores/reconnect';
import { useResume } from './hooks/useResume';
import { useSettings } from './stores/settings';
import { useServers } from './stores/servers';

function maybeNotify(sessionId: string) {
  const { notify } = useSettings.getState();
  if (!notify || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const proj = useProjects.getState().sessions.find((x) => x.id === sessionId);
  try { new Notification('Dispatch — input needed', { body: proj?.name ?? 'A session needs your input', icon: '/icons/icon-192.png' }); } catch { /* ignore */ }
}

export default function App() {
  const activeTerminalId = useTabs((s) => s.activeTabId);
  const selectTab = (id: string) => { useAgentUI.getState().blur(); useTabs.getState().setActiveTab(id); };
  const activeId = useProjects((s) => s.activeId);
  const isMobile = useIsMobile();
  const agentFocused = useAgentUI((s) => s.focused);
  const agentSelected = useAgents((s) => s.selectedId);
  const editing = useAgentUI((s) => s.editing);
  const reconnectGen = useReconnect((s) => s.gen);
  const sockRef = useRef<{ close(): void; reconnect(): void } | null>(null);

  useEffect(() => {
    void useProjects.getState().load();
    void useServers.getState().load();
    void useTabs.getState().hydrate();
    void useAuth.getState().load();
    void useAgents.getState().loadSchedules();
    const sock = createEventsSocket({
      onStatus: (s) => useConnection.getState().setStatus(s),
      onEvent: (e) => {
        useProjects.getState().applyEvent(e);
        useTabs.getState().applyEvent(e);
        useActivity.getState().applyEvent(e);
        useThreadStatus.getState().applyEvent(e);
        usePrompts.getState().applyEvent(e);
        useAuth.getState().applyEvent(e);
        useAgents.getState().applyEvent(e);
        if (e.type === 'session:status' && e.status === 'needs_input' && typeof e.sessionId === 'string') maybeNotify(e.sessionId);
      },
    });
    sockRef.current = sock;
    return () => { sock.close(); sockRef.current = null; };
  }, []);

  // Returning from the background: re-establish the events socket and remount
  // every terminal (which iOS may have silently killed) so the UI is live
  // again without the user having to back out of the view.
  useResume(() => {
    sockRef.current?.reconnect();
    useReconnect.getState().bump();
  });

  if (isMobile) {
    return (<><AuthBanner /><MobileApp /></>);
  }

  const showAgent = agentFocused && !!agentSelected;

  return (
    <>
      <AuthBanner />
      <AppShell>
        <Workspace
          sidebar={<ProjectSidebar
            onSelectTab={selectTab}
            onSelectAgent={(id) => useAgentUI.getState().selectAgent(id)}
            onNewAgent={(pid) => useAgentUI.getState().openNew(pid)}
          />}
          main={
            showAgent
              ? <AgentPane />
              : (
                <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                  <TabBar onSelect={() => useAgentUI.getState().blur()} />
                  {activeTerminalId
                    ? <TabHost key={`${activeTerminalId}:${reconnectGen}`} terminalId={activeTerminalId} />
                    : <EmptyWorkspace onSelectTab={selectTab} />}
                </div>
              )
          }
          inspector={<Inspector projectId={activeId} terminalId={activeTerminalId} onOpenFile={selectTab} />}
        />
      </AppShell>
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => useAgentUI.getState().selectAgent(id)} />}
    </>
  );
}
