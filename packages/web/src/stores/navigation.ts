import { create } from 'zustand';
import { BASE } from '../lib/basePath';
import { parseRoute, routeHref, routePath, sameRoute, type Route } from '../lib/routes';
import { useUI } from './ui';
import { useProjects } from './projects';
import { useTabs, findTerminal, isDispatchTab, dispatchSessionId, dispatchTabId } from './tabs';
import { useAgentUI } from './agentUI';
import { useAgents } from './agents';

/**
 * The navigation store (engineering program 2026-11-09, W2-F): where the app is, as a `Route`, and
 * the one way to go somewhere else.
 *
 *   navigate(route)   one history entry (none with `replace`, none for the address that is open),
 *                     then the view, the active project and the active tab through their own stores
 *   back()            the browser's back
 *
 * One `popstate` listener for the whole app lives here. Back and forward read the address and show
 * that screen again.
 *
 * Desktop. The address also follows the app: a click in the sidebar, the tab bar or the icon rail
 * changes a store, and `startDesktopSync` writes the matching address (a new entry, so Back returns
 * to the earlier thread). No caller has to know about addresses.
 *
 * Phone. The phone shell keeps its own stack (list, project, thread; settings and plugin screens with
 * no address of their own). It registers a driver (`setMobileDriver`, from
 * components/mobile/useMobileNavigation.ts): `navigate` and `popstate` then go to the driver, and the
 * driver writes its entries through `pushHistory`, so `route` is right on both shells.
 *
 * This replaced four "pending" fields on the UI store, each set by a caller and cleared by an effect
 * in whichever shell was mounted. `useUI().requestOpenThread` and its three siblings stay as thin
 * wrappers around `navigate`.
 */
export interface NavigateOptions { replace?: boolean }
export interface MobileDriver {
  navigate(route: Route, opts?: NavigateOptions): void;
  /** Back or forward landed on an entry: its `history.state`, and the route of its address. */
  onPop(state: unknown, route: Route): void;
}

interface NavigationState {
  route: Route;
  navigate(route: Route, opts?: NavigateOptions): void;
  back(): void;
}

const ROOT: Route = { view: 'workspace' };
const isRoot = (r: Route): boolean => r.view === 'workspace' && !r.projectId;
const readAddress = (): Route => { try { return parseRoute(location.pathname, BASE); } catch { return ROOT; } };

let driver: MobileDriver | null = null;
/** More than 0 while a route is being put on screen: the stores change, and the sync must not answer. */
let applying = 0;
/** Counts applies, so a slow one (a project that had to load) can see that a newer one took over. */
let applySeq = 0;
/** The address of what the stores showed when the sync last looked. null: the next look replaces the entry. */
let lastStoreKey: string | null = null;
let unsubscribers: (() => void)[] = [];

export const useNavigation = create<NavigationState>((set, get) => ({
  route: readAddress(),
  navigate: (route, opts) => {
    if (driver) { driver.navigate(route, opts); return; }
    // The address that is open already: show it again (the view may have moved), but add no entry.
    const replace = !!opts?.replace || sameRoute(route, get().route);
    writeAddress(route, replace);
    set({ route });
    void applyAndSettle(route);
  },
  back: () => history.back(),
}));

function writeAddress(route: Route, replace: boolean): void {
  const url = routeHref(route, BASE);
  try {
    if (replace) history.replaceState(history.state ?? {}, '', url);
    else history.pushState({}, '', url);
  } catch { /* a sandboxed frame without history: the app still navigates */ }
}

/**
 * One history entry written by the phone shell, with its own state object. `path` is the address
 * inside the app ('/p/a/t/b'); null keeps the address that shows (a settings or plugin screen).
 */
export function pushHistory(state: Record<string, unknown>, path: string | null, opts?: NavigateOptions): void {
  const url = path === null ? location.pathname : BASE + path;
  if (opts?.replace) history.replaceState(state, '', url); else history.pushState(state, '', url);
  useNavigation.setState({ route: readAddress() });
}

/** What the stores show now, as a route (desktop). */
export function storeRoute(): Route {
  const view = useUI.getState().view;
  if (view === 'settings') {
    const cur = useNavigation.getState().route;
    return cur.view === 'settings' ? cur : { view: 'settings' };
  }
  if (view !== 'workspace') return { view } as Route;
  const activeId = useProjects.getState().activeId;
  const agentId = useAgentUI.getState().focused ? useAgents.getState().selectedId : null;
  if (agentId) {
    const projectId = useAgents.getState().schedules.find((s) => s.id === agentId)?.projectId ?? activeId;
    if (projectId) return { view: 'workspace', projectId, agentId };
  }
  const tabs = useTabs.getState();
  const tab = tabs.activeTabId;
  if (tab && isDispatchTab(tab)) return { view: 'workspace', projectId: dispatchSessionId(tab) };
  if (tab) {
    const projectId = findTerminal(tabs.byProject, tab)?.sessionId ?? tabs.tabSession[tab];
    if (projectId) return { view: 'workspace', projectId, threadId: tab };
  }
  return activeId ? { view: 'workspace', projectId: activeId } : ROOT;
}

const projectKnown = (id: string): boolean => useProjects.getState().sessions.some((s) => s.id === id);
/**
 * Whether a project id names a project. The list in the store answers when it has the id; when it
 * does not (the list is still loading, or the id is wrong) the list is read again. The daemon answers
 * an empty thread list for an id it does not know, so the thread list cannot tell. A failed read
 * (offline) counts as "exists": nothing is thrown away on a guess.
 */
async function projectExists(id: string): Promise<boolean> {
  if (projectKnown(id)) return true;
  try { await useProjects.getState().load(); } catch { return true; }
  return projectKnown(id);
}

/**
 * Puts a route on screen (desktop) and returns the route that really shows. A thread that does not
 * exist gives its project; a project that does not exist gives the root. Everything up to a list
 * that must load first happens at once, in the caller's own turn.
 */
async function applyDesktop(route: Route, current: () => boolean): Promise<Route> {
  const ui = useUI.getState();
  if (route.view !== 'workspace') {
    if (ui.view !== route.view) ui.setView(route.view);
    return route;
  }
  if (ui.view !== 'workspace') ui.setView('workspace');
  const { projectId, threadId, agentId } = route;
  if (!projectId) return route;
  if (agentId) {
    useProjects.getState().setActive(projectId);
    useAgentUI.getState().selectAgent(agentId);
    return route;
  }
  if (!threadId) {
    useAgentUI.getState().blur();
    useProjects.getState().setActive(projectId); // at once, as before W2-F; checked below when the id is not in the list
    if (!projectKnown(projectId)) {
      if (!(await projectExists(projectId))) {
        if (current() && useProjects.getState().activeId === projectId) useProjects.setState({ activeId: useProjects.getState().sessions[0]?.id ?? null });
        return current() ? ROOT : route;
      }
      if (!current()) return route;
    }
    // On the desktop a project with no thread is its coordinator tab, when that tab is open.
    const coordinator = dispatchTabId(projectId);
    const tabs = useTabs.getState();
    if (tabs.openTabIds.includes(coordinator) && tabs.activeTabId !== coordinator) tabs.setActiveTab(coordinator);
    return route;
  }
  let terminal = findTerminal(useTabs.getState().byProject, threadId);
  if (!terminal) {
    try { await useTabs.getState().loadTabs(projectId); } catch { return ROOT; } // the project is gone
    if (!current()) return route;
    terminal = findTerminal(useTabs.getState().byProject, threadId);
    if (!terminal) { // the thread is gone: its project, when the project exists
      if (!(await projectExists(projectId))) return ROOT;
      if (!current()) return route;
      useAgentUI.getState().blur();
      useProjects.getState().setActive(projectId);
      return { view: 'workspace', projectId };
    }
  }
  useAgentUI.getState().blur();
  useProjects.getState().setActive(terminal.sessionId);
  useTabs.getState().setActiveTab(threadId);
  return terminal.sessionId === projectId ? route : { view: 'workspace', projectId: terminal.sessionId, threadId };
}

async function applyAndSettle(route: Route): Promise<void> {
  const seq = ++applySeq;
  applying++;
  let shown = route;
  try {
    shown = await applyDesktop(route, () => seq === applySeq);
  } finally {
    applying--;
  }
  if (seq !== applySeq) return; // a newer navigate took over
  if (!sameRoute(shown, route)) {
    writeAddress(shown, true);
    useNavigation.setState({ route: shown });
  }
  // The stores now show this route; a later change of theirs is a move by the user.
  lastStoreKey = isRoot(shown) ? null : routePath(storeRoute());
  if (lastStoreKey === null) syncFromStores();
}

/** The stores changed: write the address of what they show now. A no-op during a navigate and on the phone. */
function syncFromStores(): void {
  if (!unsubscribers.length || driver || applying) return;
  const route = storeRoute();
  const key = routePath(route);
  if (key === lastStoreKey) return;
  // The first look, or a look from the empty root (the project list just arrived), corrects the
  // entry that is open. Any later change is a place to come back to.
  const replace = lastStoreKey === null || lastStoreKey === '/';
  lastStoreKey = key;
  if (sameRoute(route, useNavigation.getState().route)) return;
  writeAddress(route, replace);
  useNavigation.setState({ route });
}

/** Desktop: from now on the address follows the view, the active project, the active tab and the agent pane. */
export function startDesktopSync(): void {
  if (unsubscribers.length) return;
  unsubscribers = [
    useUI.subscribe((s, p) => { if (s.view !== p.view) syncFromStores(); }),
    useProjects.subscribe((s, p) => { if (s.activeId !== p.activeId) syncFromStores(); }),
    useTabs.subscribe((s, p) => { if (s.activeTabId !== p.activeTabId) syncFromStores(); }),
    useAgentUI.subscribe((s, p) => { if (s.focused !== p.focused) syncFromStores(); }),
    useAgents.subscribe((s, p) => { if (s.selectedId !== p.selectedId) syncFromStores(); }),
  ];
}

export function stopDesktopSync(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
  lastStoreKey = null;
}

/**
 * Desktop start, after the open tabs of the last visit are restored: the address wins. A deep link
 * (`/p/A/t/T`, `/settings/secrets`) opens its screen and adds no entry; the bare root (or a path the
 * app does not know) keeps what the app shows and gets that address. Then the sync starts.
 */
export async function bootDesktopNavigation(): Promise<void> {
  if (driver) return;
  const route = readAddress();
  useNavigation.setState({ route });
  if (!isRoot(route)) await applyAndSettle(route);
  if (driver) return; // the window became a phone while a project loaded
  startDesktopSync();
  if (isRoot(route) || lastStoreKey === null) { lastStoreKey = null; syncFromStores(); }
}

/** The phone shell takes over `navigate` and `popstate` (null: back to the desktop behaviour). */
export function setMobileDriver(next: MobileDriver | null): void {
  driver = next;
  lastStoreKey = null;
}

function onPopState(e: PopStateEvent): void {
  const route = readAddress();
  useNavigation.setState({ route });
  if (driver) { driver.onPop(e.state, route); return; }
  void applyAndSettle(route);
}

// The one popstate listener. A module that loads twice (a hot reload, a test that resets modules)
// replaces the listener of its earlier copy.
if (typeof window !== 'undefined') {
  const slot = window as unknown as { __dispatchNavPop?: (e: PopStateEvent) => void };
  if (slot.__dispatchNavPop) window.removeEventListener('popstate', slot.__dispatchNavPop);
  slot.__dispatchNavPop = onPopState;
  window.addEventListener('popstate', onPopState);
}

/** Test only: forget the sync state and read the address again. */
export function __resetNavigationForTest(): void {
  stopDesktopSync();
  applySeq++;
  applying = 0;
  useNavigation.setState({ route: readAddress() });
}
