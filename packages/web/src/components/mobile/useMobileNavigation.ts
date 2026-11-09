import { useEffect, useRef, useState } from 'react';
import { BASE } from '../../lib/basePath';
import { parseRoute, routePath, type Route } from '../../lib/routes';
import { pushHistory, setMobileDriver } from '../../stores/navigation';
import { useMobileNav, openSettingsSubPage, subPageOfState, type SettingsSubPage } from '../../stores/mobileNav';
import { useProjects } from '../../stores/projects';
import { useProjectsView } from '../../stores/projectsView';
import { useTabs, findTerminal } from '../../stores/tabs';
import { useAgentUI } from '../../stores/agentUI';
import { useAgents } from '../../stores/agents';
import { usePluginRegistry } from '../../plugins/registry';

/**
 * The phone shell's navigation (W2-F, 2026-11-09): the push and restore logic that lived inside
 * MobileApp, on top of the navigation store (stores/navigation.ts).
 *
 * The phone is a three-level rail: 0 the bottom tab's root, 1 a project (or a settings section, or a
 * plugin screen), 2 a thread or an agent. Each level is one history entry, so the back button and the
 * iOS edge swipe walk up the rail. An entry's state is `{ nav: <level>, depth, ... }`.
 *
 * The store owns the one `popstate` listener and `navigate`; this hook registers as its driver. So a
 * `navigate(route)` from anywhere (a notification tap, a link in Chat, the mic's "Set up") runs the
 * phone's own push, and back / forward run `onPop` below.
 */
export type BottomTab = 'projects' | 'chat' | 'agents' | 'analytics' | 'settings' | 'plugins' | `plugin:${string}`;

type NavInit = { level: 0 | 1 | 2; projectId?: string; leaf?: 'tab' | 'agent'; tabId?: string; agentId?: string; bottomTab?: BottomTab; settingsSection?: string };
/** Where the app starts for the address it was opened on. */
function initOf(route: Route): NavInit {
  if (route.view === 'workspace') {
    if (!route.projectId) return { level: 0 };
    if (route.threadId) return { level: 2, projectId: route.projectId, leaf: 'tab', tabId: route.threadId };
    if (route.agentId) return { level: 2, projectId: route.projectId, leaf: 'agent', agentId: route.agentId };
    return { level: 1, projectId: route.projectId };
  }
  // The desktop's other addresses open their bottom tab at its root (a settings section is pushed on top).
  if (route.view === 'settings') return { level: 0, bottomTab: 'settings', settingsSection: route.section };
  return { level: 0, bottomTab: route.view };
}
const readInit = (): NavInit => initOf(parseRoute(location.pathname, BASE));

// Where a bottom tab was left (2026-11-07): the screen it reopens on.
type TabSpot =
  | { kind: 'project'; projectId: string }
  | { kind: 'thread'; projectId: string; tabId: string; viaProject: boolean }
  | { kind: 'agent'; projectId: string; agentId: string; viaProject: boolean }
  | { kind: 'settings'; section: string; sub: SettingsSubPage | null }
  | { kind: 'plugin'; view: string };

const project = (id: string): string => routePath({ view: 'workspace', projectId: id });
const thread = (id: string, tabId: string): string => routePath({ view: 'workspace', projectId: id, threadId: tabId });
const agent = (id: string, agentId: string): string => routePath({ view: 'workspace', projectId: id, agentId });

export function useMobileNavigation() {
  // Initialise straight from the URL so a reload restores the page (no flash to
  // the index, and the rail renders at the right level without an entry slide).
  const [level, setLevel] = useState<0 | 1 | 2>(() => readInit().level);
  const [projectId, setProjectId] = useState<string | null>(() => readInit().projectId ?? null);
  const [leaf, setLeaf] = useState<'tab' | 'agent'>(() => readInit().leaf ?? 'tab');
  // The thread shown at level 2 is tracked locally (from the URL) rather than via
  // the global activeTab store, which App's hydrate() can reset to null on reload.
  const [leafTabId, setLeafTabId] = useState<string | null>(() => readInit().tabId ?? null);
  // Settings is a bottom-tab destination, not an overlay: the list sits at level 0
  // and drilling into a section pushes it onto level 1 (where a project's threads
  // would otherwise be), so back / edge-swipe walk out of it like any other screen.
  const [settingsKey, setSettingsKey] = useState<string | null>(null);
  // The plugin screen opened from the Plugins tab: pushed onto level 1, like a settings section.
  const [pluginKey, setPluginKey] = useState<string | null>(null);
  // The thread list highlights a row ONLY for the thread you last opened (set in
  // openThread), so backing out of it highlights its row (then fades). Opening a
  // project fresh clears it → nothing highlighted.
  const [highlightThreadId, setHighlightThreadId] = useState<string | null>(null);
  // 'plugins' is the fixed Plugins tab; 'plugin:<id>:<view>' a promoted plugin screen (docs/superpowers/specs/2026-11-07-plugins-design.md).
  const [bottomTab, setBottomTab] = useState<BottomTab>(() => readInit().bottomTab ?? 'projects');
  // Projects ⇄ Threads: one switch shared with the desktop's left panel (stores/projectsView.ts).
  const projectsView = useProjectsView((st) => st.view);

  // Every entry this screen pushes records how many steps it sits above the root, so "back to
  // the root" is exact: a thread opened from the Threads view is ONE step up (no project entry
  // between), one opened from a project is two. `path` null keeps the address (settings, plugins).
  const pushNav = (state: Record<string, unknown>, path: string | null) => {
    const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1;
    pushHistory({ ...state, depth }, path);
  };
  const toRoot = () => {
    const depth = (history.state as { depth?: number } | null)?.depth ?? level;
    if (depth > 0) history.go(-depth);
  };
  // The bottom bar's tabs. The Projects tab walks back one screen at a time from a thread
  // (thread → its project → the list), unless the Threads view is showing, where it goes
  // straight back to that list. Any other tab goes to the root with that tab showing.
  // Each tab keeps its place (2026-11-07, iOS tab-bar style): the screen a tab was left on comes
  // back when you tap that tab again, with the same back history it had (a thread: project then
  // thread, or just the thread when it was opened from the Threads view; a plugin page in Settings:
  // the section then the page). A tap on the tab you are on goes to its root (Projects:
  // one level per tap), or scrolls its list back to the top when it is at the root already.
  // One shared history stack holds only the tab that shows; the others wait here.
  const spots = useRef<Partial<Record<string, TabSpot>>>({});
  const pendingSpot = useRef<TabSpot | null>(null);
  const spotOfCurrent = (): TabSpot | undefined => {
    const depth = (history.state as { depth?: number } | null)?.depth ?? level;
    if (level === 1 && bottomTab === 'settings' && settingsKey) {
      const sub = useMobileNav.getState().sub;
      return { kind: 'settings', section: settingsKey, sub: sub?.section === settingsKey ? sub : null };
    }
    if (level === 1 && bottomTab === 'plugins' && pluginKey) return { kind: 'plugin', view: pluginKey };
    if (bottomTab !== 'projects' || !projectId) return undefined;
    if (level === 1) return { kind: 'project', projectId };
    if (level === 2 && leaf === 'tab' && leafTabId) return { kind: 'thread', projectId, tabId: leafTabId, viaProject: depth >= 2 };
    const agentId = useAgents.getState().selectedId;
    if (level === 2 && leaf === 'agent' && agentId) return { kind: 'agent', projectId, agentId, viaProject: depth >= 2 };
    return undefined;
  };
  const restoreSpot = (spot: TabSpot) => {
    if (spot.kind === 'settings') {
      openSettingsSection(spot.section);
      if (spot.sub) openSettingsSubPage(spot.sub.section, spot.sub.id, spot.sub.title);
    } else if (spot.kind === 'plugin') {
      if (usePluginRegistry.getState().views.some((v) => v.key === spot.view)) openPluginScreen(spot.view);
    } else if (!useProjects.getState().sessions.some((p) => p.id === spot.projectId)) {
      // The project is gone: the tab opens at its list.
    } else if (spot.kind === 'project') {
      openProject(spot.projectId);
    } else if (spot.kind === 'thread') {
      if (useTabs.getState().byProject[spot.projectId]?.some((t) => t.id === spot.tabId)) reopenThread(spot);
      else openProject(spot.projectId);
    } else {
      useProjects.getState().setActive(spot.projectId); setProjectId(spot.projectId);
      if (spot.viaProject) pushNav({ nav: 1, projectId: spot.projectId }, project(spot.projectId));
      useAgentUI.getState().selectAgent(spot.agentId); setLeaf('agent'); setLevel(2);
      pushNav({ nav: 2, projectId: spot.projectId, leaf: 'agent', agentId: spot.agentId }, agent(spot.projectId, spot.agentId));
    }
  };
  // Leaves the tab that shows, keeping its place, and walks the history back to the root.
  const leaveTab = () => {
    spots.current[bottomTab] = spotOfCurrent();
    toRoot();
  };
  const level0Ref = useRef<HTMLDivElement>(null);
  const scrollRootToTop = () => {
    level0Ref.current?.querySelectorAll<HTMLElement>('*').forEach((el) => { if (el.scrollTop > 0) el.scrollTop = 0; });
  };
  const onTab = (key: BottomTab) => {
    if (key === bottomTab) {
      spots.current[key] = undefined;
      if (level === 0) { if (key !== 'chat') scrollRootToTop(); return; }
      if (key === 'projects' && projectsView !== 'threads') history.back();
      else toRoot();
      return;
    }
    const target = spots.current[key];
    spots.current[key] = undefined;
    const wasDeep = level > 0;
    leaveTab();
    setBottomTab(key);
    if (!target) return;
    // Restore once the walk back to the root has landed (the popstate handler runs it).
    if (wasDeep) pendingSpot.current = target;
    else restoreSpot(target);
  };

  // Navigation is backed by the History API so the browser back button and the
  // iOS edge-swipe-back gesture move up the stack (projects ← project ← thread).
  const openProject = (id: string) => {
    useProjects.getState().setActive(id); setProjectId(id); setLevel(1);
    setHighlightThreadId(null); // opened fresh → no thread highlighted
    pushNav({ nav: 1, projectId: id }, project(id));
  };
  const openThread = (tabId: string) => {
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(tabId); // so backing out of THIS thread highlights its row (then fades)
    pushNav({ nav: 2, projectId, leaf: 'tab', tabId }, thread(String(projectId), tabId));
  };
  const openAgent = (id: string) => {
    useAgentUI.getState().selectAgent(id); setLeaf('agent'); setLevel(2);
    pushNav({ nav: 2, projectId, leaf: 'agent', agentId: id }, agent(String(projectId), id));
  };
  // Opening an agent from the cross-project Agents tab: seed the project context
  // first (openAgent derives its URL from it), then jump straight to the agent.
  const openAgentFromList = (pid: string, scheduleId: string) => {
    useProjects.getState().setActive(pid); setProjectId(pid);
    useAgentUI.getState().selectAgent(scheduleId); setLeaf('agent'); setLevel(2);
    pushNav({ nav: 2, projectId: pid, leaf: 'agent', agentId: scheduleId }, agent(pid, scheduleId));
  };
  const reopenThread = (p: { projectId: string; tabId: string; viaProject: boolean }) => {
    useProjects.getState().setActive(p.projectId); setProjectId(p.projectId);
    if (p.viaProject) pushNav({ nav: 1, projectId: p.projectId }, project(p.projectId));
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(p.tabId); setLeafTabId(p.tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(p.tabId);
    pushNav({ nav: 2, projectId: p.projectId, leaf: 'tab', tabId: p.tabId }, thread(p.projectId, p.tabId));
  };
  // Same pattern from the cross-project Threads view: seed the project, then jump
  // straight to the thread (back returns to the root, still on the Threads view).
  const openThreadFromList = (pid: string, tabId: string) => {
    useProjects.getState().setActive(pid); setProjectId(pid);
    useAgentUI.getState().blur(); useTabs.getState().setActiveTab(tabId); setLeafTabId(tabId); setLeaf('tab'); setLevel(2);
    setHighlightThreadId(tabId);
    pushNav({ nav: 2, projectId: pid, leaf: 'tab', tabId }, thread(pid, tabId));
  };
  // Settings sections reuse level 1. No URL change: on the phone a section has no address of its
  // own, so the entry only carries enough state for back/popstate to restore it.
  const openSettingsSection = (key: string) => {
    setSettingsKey(key); setLevel(1); useMobileNav.getState().setSub(null);
    pushNav({ nav: 1, settingsSection: key }, null);
  };
  // A plugin screen from the Plugins tab: same idea as a settings section (level 1, no URL change).
  const openPluginScreen = (key: string) => {
    setPluginKey(key); setLevel(1);
    pushNav({ nav: 1, pluginView: key }, null);
  };
  const back = () => history.back();

  // A bottom tab at its root, for `navigate` to a whole view.
  const showTab = (key: BottomTab) => {
    if (key !== bottomTab) onTab(key);
    else if (level > 0) { spots.current[key] = undefined; toRoot(); }
  };
  /**
   * `navigate` on the phone. These were four pending fields on the UI store, each consumed by an
   * effect here; the behaviour of each is unchanged:
   * - a thread (a notification tap, a link in Chat, a file tab that was just made): straight to it,
   *   the project seeded first, one entry above the screen that shows;
   * - a project (the Chat pane's Docs "+N more"): the Projects tab, then the project;
   * - a settings section (the mic's "Set up" link): the Settings tab, then the section.
   * `replace` has no meaning on the rail (each level is an entry) and is ignored.
   */
  const navigate = (route: Route) => {
    if (route.view === 'workspace') {
      if (route.projectId && route.threadId) openThreadFromList(route.projectId, route.threadId);
      else if (route.projectId && route.agentId) openAgentFromList(route.projectId, route.agentId);
      else if (route.projectId) { setBottomTab('projects'); openProject(route.projectId); }
      else showTab('projects');
    } else if (route.view === 'settings') {
      if (!route.section) { showTab('settings'); return; }
      const section = route.section;
      if (bottomTab !== 'settings') leaveTab(); else toRoot();
      spots.current.settings = undefined;
      setBottomTab('settings');
      // After the walk back to the root lands, push the section (one frame for the popstate).
      setTimeout(() => openSettingsSection(section), 50);
    } else {
      showTab(route.view);
    }
  };
  const onPop = (state: unknown) => {
    const s = (state || { nav: 0 }) as { nav?: number; projectId?: string; leaf?: 'tab' | 'agent'; tabId?: string; agentId?: string; settingsSection?: string; pluginView?: string };
    // An item's page in Settings (a plugin, an account, a skill…) shows only on its own entry.
    useMobileNav.getState().setSub(subPageOfState(s));
    // Returning to a settings section (edge-swipe forward, or back into one)
    // re-selects the tab too, so the level-1 slot renders the right screen.
    if (s.settingsSection) { setSettingsKey(s.settingsSection); setBottomTab('settings'); }
    if (s.pluginView) { setPluginKey(s.pluginView); setBottomTab('plugins'); }
    if (s.projectId) { setProjectId(s.projectId); useProjects.getState().setActive(s.projectId); }
    if (s.leaf) setLeaf(s.leaf);
    if (s.tabId) { useAgentUI.getState().blur(); setLeafTabId(s.tabId); useTabs.getState().setActiveTab(s.tabId); }
    if (s.agentId) useAgentUI.getState().selectAgent(s.agentId);
    setLevel((s.nav ?? 0) as 0 | 1 | 2);
    // A tab switch walked back to the root: now reopen the new tab where it was left.
    const spot = pendingSpot.current;
    if (spot && !s.nav) { pendingSpot.current = null; restoreSpot(spot); }
  };
  // The store calls the driver long after this render: it reaches the current closures through a ref.
  const live = useRef({ navigate, onPop });
  live.current = { navigate, onPop };

  // On a deep-linked reload: restore the stores from the URL and rebuild the
  // history stack (base → project → leaf) so back/edge-swipe still walks up.
  useEffect(() => {
    const init = readInit();
    if (init.projectId) {
      useProjects.getState().setActive(init.projectId);
      const { projectId: pid, tabId } = init;
      void useTabs.getState().loadTabs(pid).then(() => {
        // A thread link whose thread is gone (deleted since the link was made): its project's list.
        // Only when the load answered, and only while that thread's screen still shows.
        if (!tabId || findTerminal(useTabs.getState().byProject, tabId)) return;
        const here = history.state as { nav?: number; tabId?: string } | null;
        if (here?.nav === 2 && here.tabId === tabId) history.back();
      }).catch(() => { /* offline, or the project is gone: the screen says so */ });
    }
    if (init.leaf === 'tab' && init.tabId) { useAgentUI.getState().blur(); setLeafTabId(init.tabId); useTabs.getState().setActiveTab(init.tabId); }
    if (init.leaf === 'agent' && init.agentId) useAgentUI.getState().selectAgent(init.agentId);
    pushHistory({ nav: 0, depth: 0 }, '/', { replace: true });
    if (init.level >= 1 && init.projectId) pushNav({ nav: 1, projectId: init.projectId }, project(init.projectId));
    if (init.level === 2 && init.projectId) {
      const path = init.leaf === 'agent' ? agent(init.projectId, String(init.agentId)) : thread(init.projectId, String(init.tabId));
      pushNav({ nav: 2, projectId: init.projectId, leaf: init.leaf, tabId: init.tabId, agentId: init.agentId }, path);
    }
    if (init.settingsSection) openSettingsSection(init.settingsSection);
    setMobileDriver({ navigate: (route) => live.current.navigate(route), onPop: (state) => live.current.onPop(state) });
    return () => setMobileDriver(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    level, projectId, leaf, leafTabId, settingsKey, pluginKey, bottomTab, highlightThreadId, level0Ref,
    onTab, openProject, openThread, openAgent, openAgentFromList, openThreadFromList, openSettingsSection, openPluginScreen, back,
  };
}
