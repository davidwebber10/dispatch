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
import { NeedsYouSection } from '../sidebar/NeedsYouSection';
import { SortMenu } from '../sidebar/SortMenu';
import { AllAgentsView } from '../agents/AllAgentsView';
import { AllThreadsView } from './AllThreadsView';
import { useProjectsView } from '../../stores/projectsView';
import { NewProjectModal } from '../sidebar/NewProjectModal';
import { FilesPane } from '../inspector/FilesPane';
import { TabHost } from '../tabs/LazyTabHost';
import { AgentPane } from '../agents/AgentPane';
import { EditAgentModal } from '../agents/EditAgentModal';
import { PluginDialogs } from '../../plugins/PluginDialogs';
import { MobileSettingsList, MobileSettingsSection } from '../settings/MobileSettings';
import { settingsSection } from '../settings/sections';
import { findTerminal, useTabs } from '../../stores/tabs';
import { useProjects } from '../../stores/projects';
import { useAgentUI } from '../../stores/agentUI';
import { useAgents } from '../../stores/agents';
import { useMobileNav } from '../../stores/mobileNav';
import { useMobileNavigation, type BottomTab } from './useMobileNavigation';
import { useReconnect } from '../../stores/reconnect';
import { useViewing } from '../../stores/viewing';
import { useSettings } from '../../stores/settings';
import { useThreadMenuBadge } from '../../plugins/menuBadge';
import { Spinner } from '../common/Spinner';
import { SortableList } from '../common/SortableList';
import { timeAgo } from '../../lib/time';
import { OverseerView } from '../overseer/LazyOverseerView';
import { useStableOrder } from '../../hooks/useStableOrder';
import { ChatMode } from '../endless/LazyChatMode';

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

export function MobileApp() {
  const projects = useProjects((s) => s.sessions);
  const byProject = useTabs((s) => s.byProject); // every project on purpose (W1-F): the project list shows a working mark per project, and the open thread can be in any of them
  const editing = useAgentUI((s) => s.editing);
  const reconnectGen = useReconnect((s) => s.gen);


  const [newProject, setNewProject] = useState(false);
  const [browseFiles, setBrowseFiles] = useState(false);
  const [query, setQuery] = useState('');
  const [projectSort, setProjectSort] = useState<ProjectSort>(() => (localStorage.getItem('dispatch:sort') as ProjectSort) || 'recent');
  useEffect(() => { try { localStorage.setItem('dispatch:sort', projectSort); } catch { /* ignore */ } }, [projectSort]);
  // The Projects tab shows either the project list or every thread across projects (2026-10-28,
  // replaced the Pinned tab). Remembered per device.
  // Projects ⇄ Threads: one switch shared with the desktop's left panel (stores/projectsView.ts).
  const projectsView = useProjectsView((st) => st.view);
  const setProjectsView = useProjectsView.getState().setView;
  // Dispatch mode (mobile): the coordinator view opens as a full-screen overlay
  // over the active project (mirrors browseFiles). Closing returns to the project.
  const [dispatchOpen, setDispatchOpen] = useState(false);

  // The rail's state, its history entries and the restore on back / forward (W2-F: the logic moved
  // to useMobileNavigation, on top of the navigation store; the four pending-intent effects that
  // lived here are that hook's `navigate`).
  const {
    level, projectId, leaf, leafTabId, settingsKey, pluginKey, bottomTab, highlightThreadId, level0Ref,
    onTab, openProject, openThread, openAgent, openAgentFromList, openThreadFromList, openSettingsSection, openPluginScreen, back,
  } = useMobileNavigation();
  const project = projects.find((p) => p.id === projectId) ?? null;
  const [listFadeKey, setListFadeKey] = useState(0); // bumps when the thread list reappears → re-fades the active row
  useEffect(() => { if (level === 1) setListFadeKey((k) => k + 1); }, [level]);

  // Presence: the thread terminal is "being viewed" only on the level-2 tab leaf.
  useEffect(() => {
    useViewing.getState().set(level === 2 && leaf === 'tab' ? leafTabId : null);
    return () => useViewing.getState().set(null);
  }, [level, leaf, leafTabId]);

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
  // Settings → a section → an item's page (a plugin, an account, a harness, a skill, a device, an
  // integration): the same leaf header, named after the item, its back arrow returning to the section.
  const settingsSub = useMobileNav((s) => s.sub);
  const subPluginName = usePluginRegistry((s) => (settingsSub?.section === 'plugins' ? s.manifests.find((m) => m.id === settingsSub.id)?.name : undefined));
  const settingsSubPage = level === 1 && inSettings && settingsSub && settingsSub.section === settingsKey
    ? { label: settingsSub.title ?? subPluginName ?? settingsSub.id, back: `Back to ${activeSettings?.label ?? 'Settings'}` } : null;
  const settingsSubOpen = !!settingsSub;
  // The page opens at its top; back to the list returns to where the list was scrolled.
  const level1Ref = useRef<HTMLDivElement>(null);
  const sectionListScroll = useRef(0);
  useEffect(() => {
    const el = level1Ref.current;
    if (el) el.scrollTop = settingsSubOpen ? 0 : sectionListScroll.current;
  }, [settingsSubOpen, settingsSub?.id]);
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
  const phoneHeaderUsage = useSettings((s) => s.phoneHeaderUsage);
  const menuBadge = useThreadMenuBadge(leafTab ?? null);

  const slot: React.CSSProperties = { flex: '0 0 100%', height: '100%', minWidth: 0 };
  const scrollSlot: React.CSSProperties = { ...slot, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}>
      {transport.confirmUi}
      {project && <ProjectMenu project={project} open={projectMenu && level === 1 && !inSettings && !inPlugins && !leafTab} onClose={() => setProjectMenu(false)} onArchived={back} />}
      <Slot name="app.overlay" />
      <ThreadMenu at={threadMenu} onClose={() => setThreadMenu(null)} onBranched={(t) => openThread(t.id)}
        leadView={transport.applies ? (close, row) => {
          // A short, quiet second line: why the switch is off, or that it stops the running turn.
          const note = !transport.canSwitch && transport.tip ? 'After a message' : transport.canSwitch && transport.midTurn ? 'Stops this turn' : null;
          return (
            <button type="button" style={{ ...row, alignItems: note ? 'flex-start' : 'center', opacity: transport.canSwitch ? 1 : 0.5 }} disabled={!transport.canSwitch} title={transport.tip}
              onClick={() => { close(); transport.request(transport.current === 'pretty' ? 'cli' : 'pretty'); }}>
              {transport.current === 'pretty'
                ? <TerminalWindow size={20} style={{ flexShrink: 0, marginTop: note ? 1 : 0 }} />
                : <ChatCircleDots size={20} style={{ flexShrink: 0, marginTop: note ? 1 : 0 }} />}
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span>{transport.current === 'pretty' ? 'Switch to CLI' : 'Switch to Pretty'}</span>
                {note && <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{note}</span>}
              </span>
            </button>
          );
        } : undefined}
        pluginRows={pluginTabs.map((p) => ({
          key: p.key, label: p.label, icon: tabIcon(p.icon),
          onPick: (tab) => setPluginSheet({ key: p.key, terminalId: tab.id, sessionId: tab.sessionId }),
        }))} />
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
          ) : settingsSubPage ? (
            <LeafHeaderTitle title={settingsSubPage.label} onBack={back} backLabel={settingsSubPage.back} testId="settings-subpage-title" />
          ) : (
          <button onClick={back} style={{ background: 'none', border: 'none', color: 'var(--color-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2, padding: '4px 2px', minWidth: 0 }}>
            <CaretLeft size={20} weight="bold" />
            <span style={{ fontWeight: 600, fontSize: 16, color: 'var(--color-text-primary)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headerTitle}</span>
          </button>
          )
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: leafTab ? 0 : 8 }}>
          {/* Account usage (#127): always shown once a provider has reported, on every screen. */}
          <UsageChip variant="phone" hideAll={!phoneHeaderUsage} only={leafTab ? { provider: leafTab.type, accountId: leafAccount?.id ?? 'cli', model: typeof leafTab.config?.model === 'string' ? leafTab.config.model : null } : null} />
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
            <button type="button" aria-label={menuBadge ? `Thread menu, ${menuBadge} new` : 'Thread menu'} title="Pretty / CLI and thread options"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setThreadMenu({ tab: leafTab, x: r.right, y: r.bottom }); }}
              style={{ ...HEADER_BOX, position: 'relative', width: HEADER_H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}>
              <DotsThree size={22} weight="bold" />
              {/* A new preview (or another plugin item's count) waits in this menu (owner, 2026-11-07). */}
              {menuBadge > 0 && <span data-testid="thread-menu-dot" aria-hidden style={{ position: 'absolute', top: 9, right: 8, width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent)', boxShadow: '0 0 0 2px var(--color-pane)' }} />}
            </button>
          )}
        </div>
        {/* Centred section title, iOS-style, while drilled into a settings section
            (the back button on the left already reads "‹ Settings"). */}
        {level === 1 && inSettings && activeSettings && !settingsSubPage && (
          <span style={{ position: 'absolute', top: 'env(safe-area-inset-top)', left: 0, right: 0, height: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', fontSize: 16, fontWeight: 600, color: 'var(--color-text-primary)' }}>{activeSettings.label}</span>
        )}
      </header>
      {/* Agents paused on a usage limit (#127): one line under the header, wraps to two. */}
      <UsageBanner compact onOpenChat={() => onTab('chat')} />

      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
        <div data-testid="mobile-rail" style={{ display: 'flex', width: '100%', height: '100%', transform: `translateX(-${level * 100}%)`, transition: 'transform .28s cubic-bezier(.4,0,.2,1)' }}>
          {/* Level 0 — projects / agents, switched by the bottom tab bar */}
          <div ref={level0Ref} style={{ ...slot, display: 'flex', flexDirection: 'column' }}>
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
              {/* The attention queue across all projects (W2-F): a list above the projects, hidden when empty.
                  Only while this list shows: the rail keeps level 0 mounted under a project or a thread. */}
              {level === 0 && !query && <NeedsYouSection onOpen={openThreadFromList} />}
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
          <div ref={level1Ref} style={inPlugins ? { ...slot, display: 'flex', flexDirection: 'column' } : scrollSlot}
            onScroll={(e) => { if (inSettings && !useMobileNav.getState().sub) sectionListScroll.current = e.currentTarget.scrollTop; }}>
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
          {([['projects', projectsView === 'threads' ? 'Threads' : 'Projects', projectsView === 'threads' ? THREADS_ICON : PROJECTS_ICON], ['chat', 'Chat', ChatCircleDots], ['analytics', 'Analytics', ChartBar], ...promotedViews.map((v) => [v.key, v.label, pluginIcon(v.icon)] as const), ...(anyPlugin ? [['plugins', 'Plugins', PuzzlePiece] as const] : []), ['settings', 'Settings', Gear]] as readonly (readonly [BottomTab, string, Icon])[]).map(([key, label, Icon]) => {
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
