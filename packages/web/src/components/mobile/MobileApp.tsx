import { useState, useEffect } from 'react';
import { Gear, CaretLeft, CaretRight, Plus } from '@phosphor-icons/react';
import { ConnectionStatus } from '../layout/ConnectionStatus';
import { BrandSwitcher } from '../layout/BrandSwitcher';
import { ProjectCard } from '../sidebar/ProjectCard';
import { NewProjectModal } from '../sidebar/NewProjectModal';
import { TabHost } from '../tabs/TabHost';
import { AgentPane } from '../agents/AgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { SettingsModal } from '../settings/SettingsModal';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useAgentUI } from '../../stores/agentUI';
import { useReconnect } from '../../stores/reconnect';
import { Spinner } from '../common/Spinner';
import { timeAgo } from '../../lib/time';

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

type NavInit = { level: 0 | 1 | 2; projectId?: string; leaf?: 'tab' | 'agent'; tabId?: string; agentId?: string };
function parsePath(path: string): NavInit {
  const m = path.match(/^\/p\/([^/]+)(?:\/(t|a)\/([^/]+))?/);
  if (!m) return { level: 0 };
  if (m[2] === 't') return { level: 2, projectId: m[1], leaf: 'tab', tabId: m[3] };
  if (m[2] === 'a') return { level: 2, projectId: m[1], leaf: 'agent', agentId: m[3] };
  return { level: 1, projectId: m[1] };
}

export function MobileApp() {
  const projects = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject);
  const editing = useAgentUI((s) => s.editing);
  const reconnectGen = useReconnect((s) => s.gen);

  // Initialise straight from the URL so a reload restores the page (no flash to
  // the index, and the rail renders at the right level without an entry slide).
  const [level, setLevel] = useState<0 | 1 | 2>(() => parsePath(location.pathname).level);
  const [projectId, setProjectId] = useState<string | null>(() => parsePath(location.pathname).projectId ?? null);
  const [leaf, setLeaf] = useState<'tab' | 'agent'>(() => parsePath(location.pathname).leaf ?? 'tab');
  // The thread shown at level 2 is tracked locally (from the URL) rather than via
  // the global activeTab store, which App's hydrate() can reset to null on reload.
  const [leafTabId, setLeafTabId] = useState<string | null>(() => parsePath(location.pathname).tabId ?? null);
  const [settings, setSettings] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const [query, setQuery] = useState('');

  const project = projects.find((p) => p.id === projectId) ?? null;

  // Navigation is backed by the History API so the browser back button and the
  // iOS edge-swipe-back gesture move up the stack (projects ← project ← thread).
  const openProject = (id: string) => {
    useProjects.getState().setActive(id); setProjectId(id); setLevel(1);
    history.pushState({ nav: 1, projectId: id }, '', `/p/${id}`);
  };
  const openThread = (tabId: string) => {
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    history.pushState({ nav: 2, projectId, leaf: 'tab', tabId }, '', `/p/${projectId}/t/${tabId}`);
  };
  const openAgent = (id: string) => {
    useAgentUI.getState().selectAgent(id); setLeaf('agent'); setLevel(2);
    history.pushState({ nav: 2, projectId, leaf: 'agent', agentId: id }, '', `/p/${projectId}/a/${id}`);
  };
  const back = () => history.back();

  // On a deep-linked reload: restore the stores from the URL and rebuild the
  // history stack (base → project → leaf) so back/edge-swipe still walks up.
  useEffect(() => {
    const init = parsePath(location.pathname);
    if (init.projectId) { useProjects.getState().setActive(init.projectId); void useTabs.getState().loadTabs(init.projectId); }
    if (init.leaf === 'tab' && init.tabId) { useAgentUI.getState().blur(); setLeafTabId(init.tabId); useTabs.getState().setActiveTab(init.tabId); }
    if (init.leaf === 'agent' && init.agentId) useAgentUI.getState().selectAgent(init.agentId);
    history.replaceState({ nav: 0 }, '', '/');
    if (init.level >= 1 && init.projectId) history.pushState({ nav: 1, projectId: init.projectId }, '', `/p/${init.projectId}`);
    if (init.level === 2 && init.projectId) {
      const url = init.leaf === 'agent' ? `/p/${init.projectId}/a/${init.agentId}` : `/p/${init.projectId}/t/${init.tabId}`;
      history.pushState({ nav: 2, projectId: init.projectId, leaf: init.leaf, tabId: init.tabId, agentId: init.agentId }, '', url);
    }
    const onPop = (e: PopStateEvent) => {
      const s = (e.state || { nav: 0 }) as { nav?: number; projectId?: string; leaf?: 'tab' | 'agent'; tabId?: string; agentId?: string };
      if (s.projectId) { setProjectId(s.projectId); useProjects.getState().setActive(s.projectId); }
      if (s.leaf) setLeaf(s.leaf);
      if (s.tabId) { useAgentUI.getState().blur(); setLeafTabId(s.tabId); useTabs.getState().setActiveTab(s.tabId); }
      if (s.agentId) useAgentUI.getState().selectAgent(s.agentId);
      setLevel((s.nav ?? 0) as 0 | 1 | 2);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const filtered = projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  // The back button labels the screen it returns TO (iOS convention): the
  // project detail goes back to "Projects"; a thread/agent goes back to its
  // project.
  const headerTitle = level === 1 ? 'Projects' : level === 2 ? (project?.name ?? 'Back') : '';

  const slot: React.CSSProperties = { flex: '0 0 100%', height: '100%', minWidth: 0 };
  const scrollSlot: React.CSSProperties = { ...slot, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      <header style={{ height: 'calc(50px + env(safe-area-inset-top))', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', paddingTop: 'env(safe-area-inset-top)', background: 'var(--color-pane)', borderBottom: '1px solid var(--color-border)' }}>
        {level === 0 ? (
          <BrandSwitcher />
        ) : (
          <button onClick={back} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px', minWidth: 0 }}>
            <CaretLeft size={20} weight="bold" />
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)', maxWidth: 210, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</span>
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ConnectionStatus />
          <button title="Settings" onClick={() => setSettings(true)} style={{ width: 30, height: 30, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
            <Gear size={17} />
          </button>
        </div>
      </header>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <div style={{ display: 'flex', width: '100%', height: '100%', transform: `translateX(-${level * 100}%)`, transition: 'transform .28s cubic-bezier(.4,0,.2,1)' }}>
          {/* Level 0 — projects */}
          <div style={scrollSlot}>
            <div style={{ display: 'flex', gap: 8, padding: 10 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects"
                style={{ flex: 1, minWidth: 0, height: 40, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 10, color: 'var(--color-text-primary)', fontSize: 16 }} />
              <button onClick={() => setNewProject(true)} title="New project" style={{ width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', border: 'none', borderRadius: 10, color: '#06140B', cursor: 'pointer' }}>
                <Plus size={20} weight="bold" />
              </button>
            </div>
            <div style={{ padding: '0 8px 12px' }}>
              {filtered.map((p) => {
                const tabs = byProject[p.id] ?? [];
                const working = p.status === 'working' || tabs.some((t) => t.status === 'working');
                return (
                  <button key={p.id} onClick={() => openProject(p.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '12px 12px', marginBottom: 6, background: 'var(--color-pane)', border: '1px solid var(--color-border)', borderRadius: 12, cursor: 'pointer' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        {working && <Spinner size={11} />}
                      </div>
                      <div style={{ font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{homePath(p.workingDir)}</div>
                    </div>
                    <span style={{ flexShrink: 0, font: '400 11px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(p.lastActivityAt)}</span>
                    <CaretRight size={18} color="var(--color-text-tertiary)" />
                  </button>
                );
              })}
              {!filtered.length && <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 13 }}>No projects</div>}
            </div>
          </div>

          {/* Level 1 — the project's threads + agents */}
          <div style={scrollSlot}>
            {project ? (
              <div style={{ padding: '8px 4px' }}>
                <ProjectCard session={project} active onSelectTab={openThread} onSelectAgent={openAgent} onNewAgent={(pid) => useAgentUI.getState().openNew(pid)} />
              </div>
            ) : <div style={{ padding: 16, color: 'var(--color-text-tertiary)' }}>No project selected</div>}
          </div>

          {/* Level 2 — the thread terminal or the agent dashboard */}
          <div style={{ ...slot, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {leaf === 'agent'
              ? <AgentPane />
              : (leafTabId ? <TabHost key={`${leafTabId}:${reconnectGen}`} terminalId={leafTabId} /> : <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No thread open</div>)}
          </div>
        </div>
      </div>

      {newProject && <NewProjectModal open onClose={() => setNewProject(false)} />}
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => openAgent(id)} />}
    </div>
  );
}
