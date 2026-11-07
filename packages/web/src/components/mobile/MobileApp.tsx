import { appPath, href } from '../../lib/basePath';
import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Gear, CaretLeft, CaretRight, Plus, ChartBar, ChatCircleDots, TerminalWindow } from '@phosphor-icons/react';
import { PROJECTS_ICON, THREADS_ICON } from '../common/viewIcons';
import { ConnectionStatus } from '../layout/ConnectionStatus';
import { BrandSwitcher } from '../layout/BrandSwitcher';
import { AlertBell } from '../layout/AlertBell';
import { UsageChip } from '../layout/UsageChip';
import { HEADER_BOX, HEADER_H } from '../layout/headerButton';
import { UsageBanner } from '../layout/UsageBanner';
import { UpdateDot } from '../update/UpdateDot';
import { PuzzlePiece } from '@phosphor-icons/react';
import { LeafHeaderTitle } from './LeafHeaderTitle';
import type { Icon } from '@phosphor-icons/react';
import { usePluginRegistry, usePromotedViews, anyBadge, useInspectorTabs } from '../../plugins/registry';
import { pluginIcon, tabIcon } from '../../plugins/sdk';
import { PluginTabSheet } from '../../plugins/PluginTabSheet';
import { PluginView, Slot } from '../../plugins/PluginView';
import { PluginsTab } from './PluginsTab';
import { ProjectMenu } from './ProjectMenu';
import { useAccounts, threadAccount, shortAccountLabel } from '../../stores/accounts';
import { DotsThree } from '@phosphor-icons/react';
import { ThreadMenu, type ThreadMenuAt } from '../sidebar/ThreadMenu';
import { useTransportSwitch } from '../layout/TransportToggle';
import { useShownStatus } from '../../stores/connection';
import { useThreadStatus } from '../../stores/threadStatus';
import { ProjectCard } from '../sidebar/ProjectCard';
import { SortMenu } from '../sidebar/SortMenu';
import { AllAgentsView } from '../agents/AllAgentsView';
import { AllThreadsView } from './AllThreadsView';
import { useProjectsView } from '../../stores/projectsView';
import { NewProjectModal } from '../sidebar/NewProjectModal';
import { FilesPane } from '../inspector/FilesPane';
import { TabHost } from '../tabs/TabHost';
import { AgentPane } from '../agents/AgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { PluginDialogs } from '../../plugins/PluginDialogs';
import { MobileSettingsList, MobileSettingsSection } from '../settings/MobileSettings';
import { settingsSection } from '../settings/sections';
import { findTerminal, useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useAgentUI } from '../../stores/agentUI';
import { useReconnect } from '../../stores/reconnect';
import { useUI } from '../../stores/ui';
import { useViewing } from '../../stores/viewing';
import { useSettings } from '../../stores/settings';
import { Spinner } from '../common/Spinner';
import { SortableList } from '../common/SortableList';
import { timeAgo } from '../../lib/time';
import { OverseerView } from '../overseer/OverseerView';
import { useStableOrder } from '../../hooks/useStableOrder';
import { ChatMode } from '../endless/ChatMode';

const AnalyticsView = lazy(() => import('../analytics/AnalyticsView').then((m) => ({ default: m.AnalyticsView })));

// Same idiom as App.tsx's desktop fallback: centered at the pane's eventual
// footprint so the ~120kB gzipped Recharts chunk downloading doesn't read as a
// blank/broken screen, and nothing jumps once it lands.
const analyticsFallback = (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%' }}>
    <Spinner size={24} />
  </div>
);

function homePath(p: string): string {
  return (p || '').replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

// Projects sort — mirrors ProjectSidebar (desktop) and shares its persisted `dispatch:sort`
// key, so the preference carries across surfaces. Mobile only ever renders MobileApp (never
// ProjectSidebar), so the mobile projects list had no sort control at all until now.
type ProjectSort = 'recent' | 'alpha' | 'custom';
const PROJECT_SORTS: [ProjectSort, string][] = [['recent', 'Most recent'], ['alpha', 'Alphabetical'], ['custom', 'Custom']];

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
  const [level, setLevel] = useState<0 | 1 | 2>(() => parsePath(appPath()).level);
  const [projectId, setProjectId] = useState<string | null>(() => parsePath(appPath()).projectId ?? null);
  const [leaf, setLeaf] = useState<'tab' | 'agent'>(() => parsePath(appPath()).leaf ?? 'tab');
  // The thread shown at level 2 is tracked locally (from the URL) rather than via
  // the global activeTab store, which App's hydrate() can reset to null on reload.
  const [leafTabId, setLeafTabId] = useState<string | null>(() => parsePath(appPath()).tabId ?? null);
  // Settings is a bottom-tab destination, not an overlay: the list sits at level 0
  // and drilling into a section pushes it onto level 1 (where a project's threads
  // would otherwise be), so back / edge-swipe walk out of it like any other screen.
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  // The plugin screen opened from the Plugins tab: pushed onto level 1, like a settings section.
  const [pluginKey, setPluginKey] = useState<string | null>(null);
  const [listFadeKey, setListFadeKey] = useState(0); // bumps when the thread list reappears → re-fades the active row
  useEffect(() => { if (level === 1) setListFadeKey((k) => k + 1); }, [level]);
  // The thread list highlights a row ONLY for the thread you last opened (set in
  // openThread), so backing out of it highlights its row (then fades). Opening a
  // project fresh clears it → nothing highlighted.
  const [highlightThreadId, setHighlightThreadId] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [browseFiles, setBrowseFiles] = useState(false);
  const [query, setQuery] = useState('');
  const [projectSort, setProjectSort] = useState<ProjectSort>(() => (localStorage.getItem('dispatch:sort') as ProjectSort) || 'recent');
  useEffect(() => { try { localStorage.setItem('dispatch:sort', projectSort); } catch { /* ignore */ } }, [projectSort]);
  // 'plugins' is the fixed Plugins tab; 'plugin:<id>:<view>' a promoted plugin screen (docs/superpowers/specs/2026-11-07-plugins-design.md).
  const [bottomTab, setBottomTab] = useState<'projects' | 'chat' | 'agents' | 'analytics' | 'settings' | 'plugins' | `plugin:${string}`>('projects');
  // The Projects tab shows either the project list or every thread across projects (2026-10-28,
  // replaced the Pinned tab). Remembered per device.
  // Projects ⇄ Threads: one switch shared with the desktop's left panel (stores/projectsView.ts).
  const projectsView = useProjectsView((st) => st.view);
  const setProjectsView = useProjectsView.getState().setView;
  // Dispatch mode (mobile): the coordinator view opens as a full-screen overlay
  // over the active project (mirrors browseFiles). Closing returns to the project.
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const project = projects.find((p) => p.id === projectId) ?? null;

  // Every entry this screen pushes records how many steps it sits above the root, so "back to
  // the root" is exact: a thread opened from the Threads view is ONE step up (no project entry
  // between), one opened from a project is two.
  const pushNav = (state: Record<string, unknown>, title: string, url: string) => {
    const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
    history.pushState({ ...state, depth }, title, url);
  };
  const toRoot = () => {
    const depth = (history.state as { depth?: number } | null)?.depth ?? level;
    if (depth > 0) history.go(-depth);
  };
  // The bottom bar's tabs. The Projects tab walks back one screen at a time from a thread
  // (thread → its project → the list), unless the Threads view is showing, where it goes
  // straight back to that list. Any other tab goes to the root with that tab showing.
  // A thread left for another tab (Thread → Chat) comes back when you tap Threads/Projects again
  // (2026-11-05), with the same back history it had: project then thread, or just the thread
  // when it was opened from the Threads view.
  const parked = useRef<{ projectId: string; tabId: string; viaProject: boolean } | null>(null);
  const onTab = (key: typeof bottomTab) => {
    if (key === 'projects' && bottomTab === 'projects' && level > 0) {
      if (projectsView === 'threads') toRoot();
      else history.back();
      return;
    }
    if (key === 'projects' && bottomTab !== 'projects' && level === 0 && parked.current) {
      const p = parked.current;
      parked.current = null;
      setBottomTab('projects');
      if (byProject[p.projectId]?.some((t) => t.id === p.tabId)) { reopenThread(p); return; }
    }
    if (bottomTab === 'projects' && key !== 'projects' && level === 2 && leaf === 'tab' && projectId && leafTabId) {
      const depth = (history.state as { depth?: number } | null)?.depth ?? 2;
      parked.current = { projectId, tabId: leafTabId, viaProject: depth >= 2 };
    }
    setBottomTab(key);
    toRoot();
  };

  // Navigation is backed by the History API so the browser back button and the
  // iOS edge-swipe-back gesture move up the stack (projects ← project ← thread).
  const openProject = (id: string) => {
    useProjects.getState().setActive(id); setProjectId(id); setLevel(1);
    setHighlightThreadId(null); // opened fresh → no thread highlighted
    pushNav({ nav: 1, projectId: id }, '', href(`/p/${id}`));
  };
  const openThread = (tabId: string) => {
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(tabId); // so backing out of THIS thread highlights its row (then fades)
    pushNav({ nav: 2, projectId, leaf: 'tab', tabId }, '', href(`/p/${projectId}/t/${tabId}`));
  };
  const openAgent = (id: string) => {
    useAgentUI.getState().selectAgent(id); setLeaf('agent'); setLevel(2);
    pushNav({ nav: 2, projectId, leaf: 'agent', agentId: id }, '', href(`/p/${projectId}/a/${id}`));
  };
  // Opening an agent from the cross-project Agents tab: seed the project context
  // first (openAgent derives its URL from it), then jump straight to the agent.
  const openAgentFromList = (pid: string, scheduleId: string) => {
    useProjects.getState().setActive(pid); setProjectId(pid);
    useAgentUI.getState().selectAgent(scheduleId); setLeaf('agent'); setLevel(2);
    pushNav({ nav: 2, projectId: pid, leaf: 'agent', agentId: scheduleId }, '', href(`/p/${pid}/a/${scheduleId}`));
  };
  const reopenThread = (p: { projectId: string; tabId: string; viaProject: boolean }) => {
    useProjects.getState().setActive(p.projectId); setProjectId(p.projectId);
    if (p.viaProject) pushNav({ nav: 1, projectId: p.projectId }, '', href(`/p/${p.projectId}`));
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(p.tabId); setLeafTabId(p.tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(p.tabId);
    pushNav({ nav: 2, projectId: p.projectId, leaf: 'tab', tabId: p.tabId }, '', href(`/p/${p.projectId}/t/${p.tabId}`));
  };
  // Same pattern from the cross-project Threads view: seed the project, then jump
  // straight to the thread (back returns to the root, still on the Threads view).
  const openThreadFromList = (pid: string, tabId: string) => {
    useProjects.getState().setActive(pid); setProjectId(pid);
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(tabId);
    pushNav({ nav: 2, projectId: pid, leaf: 'tab', tabId }, '', href(`/p/${pid}/t/${tabId}`));
  };
  // Settings sections reuse level 1. No URL change: settings isn't deep-linkable,
  // so the entry only carries enough state for back/popstate to restore it.
  const openSettingsSection = (key: string) => {
    setSettingsKey(key); setLevel(1);
    pushNav({ nav: 1, settingsSection: key }, '', location.pathname);
  };
  // A plugin screen from the Plugins tab: same idea as a settings section (level 1, no URL change).
  const openPluginScreen = (key: string) => {
    setPluginKey(key); setLevel(1);
    pushNav({ nav: 1, pluginView: key }, '', location.pathname);
  };
  const back = () => history.back();

  // View's "open file" button raises a cross-shell intent; navigate to that tab.
  const pendingOpenTab = useUI((s) => s.pendingOpenTab);
  useEffect(() => {
    if (pendingOpenTab) { openThread(pendingOpenTab); useUI.getState().clearOpenTab(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenTab]);

  // SW notification tap while the app is running: jump straight to that thread,
  // seeding the project first (openThreadFromList handles cross-project moves).
  const pendingThread = useUI((s) => s.pendingOpenThread);
  useEffect(() => {
    if (!pendingThread) return;
    useUI.getState().clearOpenThread();
    openThreadFromList(pendingThread.sessionId, pendingThread.terminalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingThread]);

  // The Chat pane's Docs "+N more": open that project in the Projects tab.
  const pendingProject = useUI((s) => s.pendingOpenProject);
  useEffect(() => {
    if (!pendingProject) return;
    useUI.getState().clearOpenProject();
    setBottomTab('projects');
    openProject(pendingProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProject]);

  // "Open Settings at this section" (the mic's "Set up" link): the Settings tab, then the section.
  const pendingSettings = useUI((s) => s.pendingSettingsSection);
  useEffect(() => {
    if (!pendingSettings) return;
    useUI.getState().clearSettingsRequest();
    setBottomTab('settings');
    toRoot();
    // After the walk back to the root lands, push the section (one frame for the popstate).
    setTimeout(() => openSettingsSection(pendingSettings), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSettings]);

  // Presence: the thread terminal is "being viewed" only on the level-2 tab leaf.
  useEffect(() => {
    useViewing.getState().set(level === 2 && leaf === 'tab' ? leafTabId : null);
    return () => useViewing.getState().set(null);
  }, [level, leaf, leafTabId]);

  // On a deep-linked reload: restore the stores from the URL and rebuild the
  // history stack (base → project → leaf) so back/edge-swipe still walks up.
  useEffect(() => {
    const init = parsePath(appPath());
    if (init.projectId) { useProjects.getState().setActive(init.projectId); void useTabs.getState().loadTabs(init.projectId); }
    if (init.leaf === 'tab' && init.tabId) { useAgentUI.getState().blur(); setLeafTabId(init.tabId); useTabs.getState().setActiveTab(init.tabId); }
    if (init.leaf === 'agent' && init.agentId) useAgentUI.getState().selectAgent(init.agentId);
    history.replaceState({ nav: 0, depth: 0 }, '', href('/'));
    if (init.level >= 1 && init.projectId) pushNav({ nav: 1, projectId: init.projectId }, '', href(`/p/${init.projectId}`));
    if (init.level === 2 && init.projectId) {
      const url = init.leaf === 'agent' ? `/p/${init.projectId}/a/${init.agentId}` : `/p/${init.projectId}/t/${init.tabId}`;
      pushNav({ nav: 2, projectId: init.projectId, leaf: init.leaf, tabId: init.tabId, agentId: init.agentId }, '', href(url));
    }
    const onPop = (e: PopStateEvent) => {
      const s = (e.state || { nav: 0 }) as { nav?: number; projectId?: string; leaf?: 'tab' | 'agent'; tabId?: string; agentId?: string; settingsSection?: string; pluginView?: string };
      // Returning to a settings section (edge-swipe forward, or back into one)
      // re-selects the tab too, so the level-1 slot renders the right screen.
      if (s.settingsSection) { setSettingsKey(s.settingsSection); setBottomTab('settings'); }
      if (s.pluginView) { setPluginKey(s.pluginView); setBottomTab('plugins'); }
      if (s.projectId) { setProjectId(s.projectId); useProjects.getState().setActive(s.projectId); }
      if (s.leaf) setLeaf(s.leaf);
      if (s.tabId) { useAgentUI.getState().blur(); setLeafTabId(s.tabId); useTabs.getState().setActiveTab(s.tabId); }
      if (s.agentId) useAgentUI.getState().selectAgent(s.agentId);
      setLevel((s.nav ?? 0) as 0 | 1 | 2);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const ordered = useStableOrder(projects, projectSort);
  const sortedProjects = ordered.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  // The back button labels the screen it returns TO (iOS convention): the
  // project detail goes back to "Projects"; a thread/agent goes back to its
  // project.
  const inSettings = bottomTab === 'settings';
  const inPlugins = bottomTab === 'plugins';
  const promotedViews = usePromotedViews();
  const badges = usePluginRegistry((s) => s.badges);
  const pluginsDot = usePluginRegistry((st) => anyBadge(st, true));
  const anyPlugin = usePluginRegistry((s) => s.views.length > 0 || s.manifests.length > 0);
  const activeSettings = settingsKey ? settingsSection(settingsKey) : undefined;
  const pluginLabel = usePluginRegistry((s) => (pluginKey ? s.views.find((v) => v.key === pluginKey)?.label : undefined));
  const pluginScreen = level === 1 && inPlugins && pluginKey ? { label: pluginLabel ?? 'Plugin' } : null;
  const headerTitle = level === 1 ? (inSettings ? 'Settings' : 'Projects') : level === 2 ? (project?.name ?? 'Back') : '';
  // In a thread (2026-11-06, header option C): the title is the thread's own name, with its status,
  // status dot and account underneath (no project or Pretty/CLI label since 2026-11-06: the Back
  // button names the project and the body shows the mode); Previews and the CLI ⇄ Pretty switch
  // live in the ⋯ menu, which carries the unseen-previews badge.
  const leafTab = level === 2 && leaf === 'tab' && leafTabId ? findTerminal(byProject, leafTabId) : undefined;
  const transport = useTransportSwitch(leafTab ? leafTab.id : null);
  const leafStatus = useThreadStatus((s) => (leafTab ? s.byTerminal[leafTab.id]?.threadStatus : undefined));
  const statusColor = leafStatus === 'working' || leafStatus === 'starting' ? 'var(--color-accent)'
    : leafStatus === 'needs_input' ? 'var(--color-status-yellow)'
      : leafStatus === 'error' ? 'var(--color-status-red)' : 'var(--color-text-tertiary)';
  const [threadMenu, setThreadMenu] = useState<ThreadMenuAt | null>(null);
  // Plugins' right-column tabs: rows in the thread's ⋯ menu, each opening a full-height sheet.
  const pluginTabs = useInspectorTabs();
  const [pluginSheet, setPluginSheet] = useState<{ key: string; terminalId: string; sessionId: string } | null>(null);
  // The project screen's ⋯ menu (2026-11-06): its header matches the thread screen's.
  const [projectMenu, setProjectMenu] = useState(false);
  const connection = useShownStatus();
  // The account under the thread name (multi-account, 2026-11-06): "Work".
  const accountsView = useAccounts((s) => s.view);
  useEffect(() => { if (leafTab) void useAccounts.getState().load(); }, [leafTab]);
  const leafAccount = threadAccount(accountsView, leafTab);

  const slot: React.CSSProperties = { flex: '0 0 100%', height: '100%', minWidth: 0 };
  const scrollSlot: React.CSSProperties = { ...slot, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      {transport.confirmUi}
      {project && <ProjectMenu project={project} open={projectMenu && level === 1 && !inSettings && !inPlugins && !leafTab} onClose={() => setProjectMenu(false)} onArchived={back} />}
      <Slot name="app.overlay" />
      <ThreadMenu at={threadMenu} onClose={() => setThreadMenu(null)} onBranched={(t) => openThread(t.id)}
        lead={(close, row) => (
          <>
            {transport.applies && (
              <button type="button" style={{ ...row, opacity: transport.canSwitch ? 1 : 0.5 }} disabled={!transport.canSwitch} title={transport.tip}
                onClick={() => { close(); transport.request(transport.current === 'pretty' ? 'cli' : 'pretty'); }}>
                <TerminalWindow size={17} />{transport.current === 'pretty' ? 'Switch to CLI' : 'Switch to Pretty'}
                {!transport.canSwitch && transport.tip && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-tertiary)' }}>after a message</span>}
                {transport.canSwitch && transport.midTurn && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-status-yellow)' }}>stops this turn</span>}
              </button>
            )}
            {threadMenu && pluginTabs.map((p) => {
              const PIcon = tabIcon(p.icon);
              const tab = threadMenu.tab;
              return (
                <button key={p.key} type="button" style={row} onClick={() => { close(); setPluginSheet({ key: p.key, terminalId: tab.id, sessionId: tab.sessionId }); }}>
                  <PIcon size={17} />{p.label}
                </button>
              );
            })}
            <div aria-hidden style={{ height: 1, background: 'var(--color-border)', margin: '4px 6px' }} />
          </>
        )} />
      <PluginTabSheet tabKey={pluginSheet?.key ?? null} terminalId={pluginSheet?.terminalId ?? null} sessionId={pluginSheet?.sessionId ?? null} onClose={() => setPluginSheet(null)} />
      <header style={{ position: 'relative', height: 'calc(50px + env(safe-area-inset-top))', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', paddingTop: 'env(safe-area-inset-top)', background: 'var(--color-pane)' }}>
        {level === 0 ? (
          <>
            <BrandSwitcher />
            {/* One-line top bar: the project search lives IN the header beside the app icon
                (it used to be a second full-width row below it). Sized down to the header's
                50px; fontSize stays 16 — anything smaller makes iOS zoom the page on focus. */}
            {bottomTab === 'projects' && (
              <>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={projectsView === 'threads' ? 'Search threads' : 'Search projects'}
                  style={{ flex: 1, minWidth: 0, height: 36, padding: '0 12px', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-primary)', fontSize: 16 }} />
                {projectsView === 'projects' && <SortMenu
                  value={projectSort}
                  options={PROJECT_SORTS}
                  onChange={(v) => setProjectSort(v as ProjectSort)}
                  isMobile
                  iconSize={18}
                  buttonStyle={{ width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-elevated)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius-md)', color: 'var(--color-text-secondary)', cursor: 'pointer' }}
                />}
                {projectsView === 'projects' && <button onClick={() => setNewProject(true)} title="New project" style={{ width: 36, height: 36, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-accent)', border: 'none', borderRadius: 'var(--radius-md)', color: 'var(--color-on-accent)', cursor: 'pointer' }}>
                  <Plus size={18} weight="bold" />
                </button>}
              </>
            )}
          </>
        ) : (
          leafTab ? (
            <LeafHeaderTitle title={leafTab.label} onBack={back} backLabel={`Back to ${project?.name ?? 'project'}`} testId="thread-title"
              subtitle={(
                <span style={{ font: '400 11.5px var(--font-mono)', color: 'var(--color-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span aria-hidden style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: statusColor, marginRight: 5, verticalAlign: 1 }} />
                  {leafAccount ? shortAccountLabel(leafAccount.label) : ''}
                </span>
              )} />
          ) : pluginScreen ? (
            <LeafHeaderTitle title={pluginScreen.label} onBack={back} backLabel="Back to Plugins" testId="plugin-title" />
          ) : (
          <button onClick={back} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px', minWidth: 0 }}>
            <CaretLeft size={20} weight="bold" />
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</span>
          </button>
          )
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Account usage (#127): always shown once a provider has reported, on every screen. */}
          <UsageChip variant="phone" only={leafTab ? { provider: leafTab.type, accountId: leafAccount?.id ?? 'cli' } : null} />
          {/* Inside a project (its threads list): the same shape as a thread's header, usage then ⋯.
              Previews (spec 2026-10-28) and the project's own actions live in that menu. */}
          {level === 1 && !inSettings && !inPlugins && project && !leafTab && <Slot name="project.header.actions" session={project} />}
          {level === 1 && !inSettings && !inPlugins && project && !leafTab && (
            <button type="button" aria-label="Project menu" title="Project options"
              onClick={() => setProjectMenu(true)}
              style={{ ...HEADER_BOX, position: 'relative', width: HEADER_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}>
              <DotsThree size={22} weight="bold" />
            </button>
          )}
          {leafTab && <Slot name="thread.header.actions" terminal={leafTab} />}
          {leafTab && <AlertBell terminalId={leafTab.id} />}
          {leafTab && (
            <button type="button" aria-label="Thread menu" title="Pretty / CLI and thread options"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setThreadMenu({ tab: leafTab, x: r.right, y: r.bottom }); }}
              style={{ ...HEADER_BOX, position: 'relative', width: HEADER_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}>
              <DotsThree size={22} weight="bold" />
            </button>
          )}
        </div>
        {/* Centred section title, iOS-style, while drilled into a settings section
            (the back button on the left already reads "‹ Settings"). */}
        {level === 1 && inSettings && activeSettings && (
          <span style={{ position: 'absolute', top: 'env(safe-area-inset-top)', left: 0, right: 0, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{activeSettings.label}</span>
        )}
      </header>
      {/* Agents paused on a usage limit (#127): one line under the header, wraps to two. */}
      <UsageBanner compact onOpenChat={() => onTab('chat')} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <div style={{ display: 'flex', width: '100%', height: '100%', transform: `translateX(-${level * 100}%)`, transition: 'transform .28s cubic-bezier(.4,0,.2,1)' }}>
          {/* Level 0 — projects / agents, switched by the bottom tab bar */}
          <div style={{ ...slot, display: 'flex', flexDirection: 'column' }}>
            {bottomTab === 'chat' ? (
              <ChatMode mobile />
            ) : bottomTab === 'analytics' ? (
              <Suspense fallback={analyticsFallback}><AnalyticsView /></Suspense>
            ) : bottomTab === 'settings' ? (
              <MobileSettingsList onOpen={openSettingsSection} />
            ) : bottomTab === 'plugins' ? (
              <PluginsTab onOpen={openPluginScreen} />
            ) : bottomTab.startsWith('plugin:') ? (
              <PluginView viewKey={bottomTab} />
            ) : bottomTab === 'agents' ? (
              <AllAgentsView onOpenAgent={openAgentFromList} />
            ) : (
            <>
            {/* Projects ⇄ Threads: a segmented switch at the top of the tab. */}
            <div role="tablist" aria-label="Projects view" style={{ display: 'flex', margin: '8px 12px 2px', padding: 3, background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', flexShrink: 0 }}>
              {([['projects', 'Projects'], ['threads', 'Threads']] as const).map(([key, label]) => {
                const on = projectsView === key;
                return (
                  <button key={key} type="button" role="tab" aria-selected={on} onClick={() => setProjectsView(key)}
                    style={{ flex: 1, height: 32, border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 13.5, fontWeight: on ? 600 : 500, background: on ? 'var(--color-pane)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? '0 1px 2px var(--color-shadow)' : 'none' }}>
                    {label}
                  </button>
                );
              })}
            </div>
            {projectsView === 'threads' ? (
              <AllThreadsView onOpenThread={openThreadFromList} query={query} />
            ) : (
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y', padding: '6px 4px 12px' }}>
              <SortableList
                items={sortedProjects}
                disabled={!!query}
                onReorder={(orderedIds) => { if (projectSort !== 'custom') setProjectSort('custom'); void useProjects.getState().reorder(orderedIds); }}
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
              {!sortedProjects.length && <div style={{ padding: 16, color: 'var(--color-text-tertiary)', fontSize: 13 }}>No projects</div>}
            </div>
            )}
            </>
            )}
          </div>

          {/* Level 1 — the project's threads + agents, with a Dispatch button at the
              top of the card (opens the coordinator as a full-screen overlay). */}
          <div style={inPlugins ? { ...slot, display: 'flex', flexDirection: 'column' } : scrollSlot}>
            {inPlugins ? (
              pluginKey ? <PluginView viewKey={pluginKey} /> : null
            ) : inSettings ? (
              settingsKey ? <MobileSettingsSection sectionKey={settingsKey} /> : null
            ) : project ? (
              <div style={{ padding: '8px 4px' }}>
                <ProjectCard session={project} active fadeActiveKey={listFadeKey} highlightTabId={highlightThreadId} onSelectTab={openThread} onSelectAgent={openAgent} onNewAgent={(pid) => useAgentUI.getState().openNew(pid)} onBrowseFiles={() => setBrowseFiles(true)} onDispatch={() => setDispatchOpen(true)} />
              </div>
            ) : <div style={{ padding: 16, color: 'var(--color-text-tertiary)' }}>No project selected</div>}
          </div>

          {/* Level 2 — the thread terminal or the agent dashboard */}
          <div style={{ ...slot, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative', ['--composer-safe-bottom' as string]: '0px' }}>
            {/* Only a real drop: a healthy connection needs no label (useShownStatus waits 1.5 s). */}
            {leaf === 'tab' && leafTabId && connection !== 'open' && findTerminal(byProject, leafTabId)?.type !== 'grok' && (
              <div style={{ position: 'absolute', top: 8, right: 10, zIndex: 5, pointerEvents: 'none', display: 'flex', alignItems: 'center', lineHeight: 1, background: 'color-mix(in srgb, var(--color-base) 60%, transparent)', borderRadius: 'var(--radius-md)', padding: '5px 9px', backdropFilter: 'blur(4px)' }}>
                <ConnectionStatus shown={connection} />
              </div>
            )}
            {leaf === 'agent'
              ? <AgentPane />
              : (leafTabId ? <TabHost key={`${leafTabId}:${reconnectGen}`} terminalId={leafTabId} /> : <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No thread open</div>)}
          </div>
        </div>
      </div>

      {/* Bottom tab bar — Projects / Chat / Analytics / Settings. Automations
          is hidden on mobile (desktop only). Visible on every screen, a thread or
          agent included (2026-11-05: the thread composer lost its key row, which
          paid for the space). Tapping a tab pops back to the root. */}
      {(
        <div data-testid="bottom-tabs" style={{ flexShrink: 0, display: 'flex', borderTop: '1px solid var(--color-border)', background: 'var(--color-pane)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {/* The first tab follows the Projects ⇄ Threads switch: its label and icon name
              whichever list it opens to. */}
          {([['projects', projectsView === 'threads' ? 'Threads' : 'Projects', projectsView === 'threads' ? THREADS_ICON : PROJECTS_ICON], ['chat', 'Chat', ChatCircleDots], ['analytics', 'Analytics', ChartBar], ...promotedViews.map((v) => [v.key, v.label, pluginIcon(v.icon)] as const), ...(anyPlugin ? [['plugins', 'Plugins', PuzzlePiece] as const] : []), ['settings', 'Settings', Gear]] as readonly (readonly [typeof bottomTab, string, Icon])[]).map(([key, label, Icon]) => {
            const on = bottomTab === key || (key === 'plugins' && bottomTab.startsWith('plugin:') && !promotedViews.some((v) => v.key === bottomTab));
            return (
              <button key={key} onClick={() => onTab(key)}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '8px 0 6px', background: 'none', border: 'none', cursor: 'pointer', color: on ? 'var(--color-accent)' : 'var(--color-text-secondary)' }}>
                {/* The Settings tab carries a plain dot while an update waits (2026-11-07). */}
                <span style={{ position: 'relative', display: 'flex' }}>
                  <Icon size={23} weight={on ? 'fill' : 'regular'} />
                  {key === 'settings' && <UpdateDot style={{ top: -2, right: -4 }} />}
                  {/* A promoted plugin screen carries its unseen count; the Plugins tab a plain dot when a screen inside it has one. */}
                  {(badges[key] ?? 0) > 0 && (
                    <span aria-label={`${badges[key]} new`} style={{ position: 'absolute', top: -5, left: '100%', marginLeft: -6, minWidth: 16, height: 16, padding: '0 4px', borderRadius: 'var(--radius-md)', background: 'var(--color-accent)', color: 'var(--color-on-accent)', font: '700 10px var(--font-sans)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 2px var(--color-pane)' }}>
                      {badges[key] > 99 ? '99+' : badges[key]}
                    </span>
                  )}
                  {key === 'plugins' && pluginsDot && <span aria-label="Plugin news" role="status" style={{ position: 'absolute', top: -2, right: -4, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', boxShadow: '0 0 0 2px var(--color-pane)' }} />}
                </span>
                <span style={{ fontSize: 11, fontWeight: on ? 600 : 500 }}>{label}</span>
              </button>
            );
          })}
        </div>
      )}

      {newProject && <NewProjectModal open onClose={() => setNewProject(false)} />}
      {editing && <EditAgentModal scheduleId={editing.scheduleId} presetProjectId={editing.preset} onClose={() => useAgentUI.getState().closeEdit()} onSaved={(id) => openAgent(id)} />}
      <PluginDialogs onAgentSaved={(id) => openAgent(id)} onThreadCreated={(pid, id) => openThreadFromList(pid, id)} />

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
