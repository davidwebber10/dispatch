import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { Workspace } from './components/layout/Workspace';
import { TabBar } from './components/layout/TabBar';
import { ProjectSidebar } from './components/sidebar/ProjectSidebar';
import { TabHost } from './components/tabs/TabHost';
import { Inspector } from './components/inspector/Inspector';
import { AgentsView } from './components/agents/AgentsView';
import { AuthBanner } from './components/auth/AuthBanner';
import { MobileApp } from './components/mobile/MobileApp';
import { useIsMobile } from './hooks/useIsMobile';
import { createEventsSocket } from './api/events-socket';
import { useConnection } from './stores/connection';
import { useProjects } from './stores/projects';
import { useTabs } from './stores/tabs';
import { useActivity } from './stores/activity';
import { useAuth } from './stores/auth';
import { useAgents } from './stores/agents';
import { useUI } from './stores/ui';
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
  const selectTab = (id: string) => useTabs.getState().setActiveTab(id);
  const activeId = useProjects((s) => s.activeId);
  const view = useUI((s) => s.view);
  const isMobile = useIsMobile();

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
        useAuth.getState().applyEvent(e);
        useAgents.getState().applyEvent(e);
        if (e.type === 'session:status' && e.status === 'needs_input' && typeof e.sessionId === 'string') maybeNotify(e.sessionId);
      },
    });
    return () => sock.close();
  }, []);

  if (isMobile) {
    return (<><AuthBanner /><MobileApp /></>);
  }

  return (
    <>
      <AuthBanner />
      <AppShell>
        {view === 'workspace' ? (
          <Workspace
            sidebar={<ProjectSidebar onSelectTab={selectTab} />}
            main={
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
                <TabBar />
                {activeTerminalId
                  ? <TabHost key={activeTerminalId} terminalId={activeTerminalId} />
                  : <div style={{ padding: 12, color: 'var(--color-text-secondary)' }}>Select a thread</div>}
              </div>
            }
            inspector={<Inspector projectId={activeId} terminalId={activeTerminalId} onOpenFile={selectTab} />}
          />
        ) : (
          <AgentsView />
        )}
      </AppShell>
    </>
  );
}
