import { useState, useEffect } from 'react';
import { Gear, CaretLeft, CaretRight, Plus, Folders, Robot } from '@phosphor-icons/react';
import { ConnectionStatus } from '../layout/ConnectionStatus';
import { BrandSwitcher } from '../layout/BrandSwitcher';
import { ModeToggle } from '../layout/ModeToggle';
import { ProjectCard } from '../sidebar/ProjectCard';
import { AllAgentsView } from '../agents/AllAgentsView';
import { NewProjectModal } from '../sidebar/NewProjectModal';
import { FilesPane } from '../inspector/FilesPane';
import { TabHost } from '../tabs/TabHost';
import { AgentPane } from '../agents/AgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { SettingsModal } from '../settings/SettingsModal';
import { useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useAgentUI } from '../../stores/agentUI';
import { useReconnect } from '../../stores/reconnect';
import { useUI } from '../../stores/ui';
import { Spinner } from '../common/Spinner';
import { SortableList } from '../common/SortableList';
import { timeAgo } from '../../lib/time';
import { OverseerView } from '../overseer/OverseerView';

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
  const [listFadeKey, setListFadeKey] = useState(0); // bumps when the thread list reappears → re-fades the active row
  useEffect(() => { if (level === 1) setListFadeKey((k) => k + 1); }, [level]);
  // The thread list highlights a row ONLY for the thread you last opened (set in
  // openThread), so backing out of it highlights its row (then fades). Opening a
  // project fresh clears it → nothing highlighted.
  const [highlightThreadId, setHighlightThreadId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [browseFiles, setBrowseFiles] = useState(false);
  const [query, setQuery] = useState('');
  const [bottomTab, setBottomTab] = useState<'projects' | 'agents'>('projects');
  // Dispatch mode (mobile): the coordinator view opens as a full-screen overlay
  // over the active project (mirrors browseFiles). Closing returns to the project.
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;

  // Navigation is backed by the History API so the browser back button and the
  // iOS edge-swipe-back gesture move up the stack (projects ← project ← thread).
  const openProject = (id: string) => {
    useProjects.getState().setActive(id); setProjectId(id); setLevel(1);
    setHighlightThreadId(null); // opened fresh → no thread highlighted
    history.pushState({ nav: 1, projectId: id }, '', `/p/${id}`);
  };
  const openThread = (tabId: string) => {
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(tabId); // so backing out of THIS thread highlights its row (then fades)
    history.pushState({ nav: 2, projectId, leaf: 'tab', tabId }, '', `/p/${projectId}/t/${tabId}`);
  };
  const openAgent = (id: string) => {
    useAgentUI.getState().selectAgent(id); setLeaf('agent'); setLevel(2);
    history.pushState({ nav: 2, projectId, leaf: 'agent', agentId: id }, '', `/p/${projectId}/a/${id}`);
  };
  // Opening an agent from the cross-project Agents tab: seed the project context
  // first (openAgent derives its URL from it), then jump straight to the agent.
  const openAgentFromList = (pid: string, scheduleId: string) => {
    useProjects.getState().setActive(pid); setProjectId(pid);
    useAgentUI.getState().selectAgent(scheduleId); setLeaf('agent'); setLevel(2);
    history.pushState({ nav: 2, projectId: pid, leaf: 'agent', agentId: scheduleId }, '', `/p/${pid}/a/${scheduleId}`);
  };
  const back = () => history.back();

  // View's "open file" button raises a cross-shell intent; navigate to that tab.
  const pendingOpenTab = useUI((s) => s.pendingOpenTab);
  useEffect(() => {
    if (pendingOpenTab) { openThread(pendingOpenTab); useUI.getState().clearOpenTab(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenTab]);

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
      <header style={{ position: 'relative', height: 'calc(50px + env(safe-area-inset-top))', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', paddingTop: 'env(safe-area-inset-top)', background: 'var(--color-pane)' }}>
        {level === 0 ? (
          <BrandSwitcher />
        ) : (
          <button onClick={back} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px', minWidth: 0 }}>
            <CaretLeft size={20} weight="bold" />
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</span>
          </button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ModeToggle terminalId={level === 2 && leaf === 'tab' ? leafTabId : null} />
          <button title="Settings" onClick={() => setSettings(true)} style={{ width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, background: 'var(--color-elevated)', border: '1px solid #2C2C32', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
            <Gear size={17} />
          </button>
        </div>
      </header>
      <SettingsModal open={settings} onClose={() => setSettings(false)} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <div style={{ display: 'flex', width: '100%', height: '100%', transform: `translateX(-${level * 100}%)`, transition: 'transform .28s cubic-bezier(.4,0,.2,1)' }}>
          {/* Level 0 — projects / agents, switched by the bottom tab bar */}
          <div style={{ ...slot, display: 'flex', flexDirection: 'column' }}>
            {bottomTab === 'agents' ? (
              <AllAgentsView onOpenAgent={openAgentFromList} />
            ) : (
            <>
            <div style={{ display: 'flex', gap: 8, padding: 10, flexShrink: 0 }}>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects"
                style={{ flex: 1, minWidth: 0, height: 40, padding: '0 13px', background: 'var(--color-elevated)', border: '1px solid #2C2C32', borderRadius: 12, color: 'var(--color-text-primary)', fontSize: 16 }} />
              <button onClick={() => setNewProject(true)} title="New project" style={{ width: 40, height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', border: 'none', borderRadius: 12, color: '#06140B', cursor: 'pointer' }}>
                <Plus size={20} weight="bold" />
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '0 4px 12px' }}>
              <SortableList
                items={filtered}
                disabled={!!query}
                onReorder={(orderedIds) => void useProjects.getState().reorder(orderedIds)}
                renderItem={(p) => {
                  const tabs = byProject[p.id] ?? [];
                  const working = p.status === 'working' || tabs.some((t) => t.status === 'working');
                  return (
                    <button onClick={() => openProject(p.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '15px 12px', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{p.name}</span>
                        <div style={{ font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{homePath(p.workingDir)}</div>
                      </div>
                      {working
                        ? <Spinner size={13} />
                        : <span style={{ flexShrink: 0, font: '400 12px var(--font-mono)', color: 'var(--color-text-tertiary)' }}>{timeAgo(p.lastActivityAt)}</span>}
                      <CaretRight size={18} color="var(--color-text-tertiary)" />
                    </button>
                  );
                }}
              />
              {!filtered.length && <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 13 }}>No projects</div>}
            </div>
            </>
            )}
            {/* Bottom tab bar — Projects / Agents (only at the root; slides away with the rail) */}
            <div style={{ flexShrink: 0, display: 'flex', borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
              {([['projects', 'Projects', Folders], ['agents', 'Automations', Robot]] as const).map(([key, label, Icon]) => {
                const on = bottomTab === key;
                return (
                  <button key={key} onClick={() => setBottomTab(key)}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 0 6px', background: 'none', border: 'none', cursor: 'pointer', color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                    <Icon size={23} weight={on ? 'fill' : 'regular'} />
                    <span style={{ fontSize: 11, fontWeight: on ? 600 : 500 }}>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Level 1 — the project's threads + agents, with a Dispatch button at the
              top of the card (opens the coordinator as a full-screen overlay). */}
          <div style={scrollSlot}>
            {project ? (
              <div style={{ padding: '8px 4px' }}>
                <ProjectCard session={project} active fadeActiveKey={listFadeKey} highlightTabId={highlightThreadId} onSelectTab={openThread} onSelectAgent={openAgent} onNewAgent={(pid) => useAgentUI.getState().openNew(pid)} onBrowseFiles={() => setBrowseFiles(true)} onDispatch={() => setDispatchOpen(true)} />
              </div>
            ) : <div style={{ padding: 16, color: 'var(--color-text-tertiary)' }}>No project selected</div>}
          </div>

          {/* Level 2 — the thread terminal or the agent dashboard */}
          <div style={{ ...slot, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
            {leaf === 'tab' && leafTabId && (
              <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 5, pointerEvents: 'none', display: 'flex', alignItems: 'center', lineHeight: 1, background: 'rgba(10,10,12,.6)', borderRadius: 8, padding: '5px 9px', backdropFilter: 'blur(4px)' }}>
                <ConnectionStatus />
              </div>
            )}
            {leaf === 'agent'
              ? <AgentPane />
              : (leafTabId ? <TabHost key={`${leafTabId}:${reconnectGen}`} terminalId={leafTabId} /> : <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No thread open</div>)}
          </div>
        </div>
      </div>

      {newProject && <NewProjectModal open onClose={() => setNewProject(false)} />}
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => openAgent(id)} />}

      {browseFiles && project && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--color-base)', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
          <header style={{ height: 50, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-pane)' }}>
            <button onClick={() => setBrowseFiles(false)} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px' }}>
              <CaretLeft size={20} weight="bold" />
              <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)' }}>Files</span>
            </button>
          </header>
          <div style={{ flex: 1, minHeight: 0 }}>
            <FilesPane projectId={project.id} onOpenFile={(id) => { setBrowseFiles(false); openThread(id); }} />
          </div>
        </div>
      )}

      {dispatchOpen && project && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'var(--color-base)', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
          {/* No separate back-nav bar here — OverseerView's single consolidated header carries
              the back ‹ (via onBack), the coordinator name, and the needs/working badges. */}
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <OverseerView onBack={() => setDispatchOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
