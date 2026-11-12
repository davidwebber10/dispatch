import { useEffect, useRef, lazy, Suspense } from 'react';
import { SetupWizard } from './components/setup/LazySetupWizard';
import { useUsageLimits } from './stores/usageLimits';
import { AuthBanner } from './components/auth/AuthBanner';
import { UpdateModal } from './components/update/UpdateModal';
import { HighScoreCelebration } from './components/update/HighScoreCelebration';
import { useEndless } from './stores/endless';
import { HintToast } from './components/common/HintToast';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useIsMobile } from './hooks/useIsMobile';
import { useTabCycleShortcut } from './hooks/useTabCycleShortcut';
import { useAttentionShortcut } from './lib/attention';
import { createEventsSocket, type EventsSocket } from './api/events-socket';
import { preloadTerminalTab } from './components/tabs/LazyTerminalTab';
import { preloadTabHost } from './components/tabs/LazyTabHost';
import { preloadOverseerView } from './components/overseer/LazyOverseerView';
import { preloadChatMode } from './components/endless/LazyChatMode';
import { writeSnapshot } from './lib/launchSnapshot';
import { useSpinnerWords } from './stores/spinnerWords';
import { useConnection } from './stores/connection';
import { useProjects } from './stores/projects';
import { useTabs, isDispatchTab } from './stores/tabs';
import { useActivity } from './stores/activity';
import { useThreadStatus } from './stores/threadStatus';
import { useAuth } from './stores/auth';
import { useUpdate } from './stores/update';
import { applyPluginEvent } from './plugins/host';
import { useHost } from './stores/host';
import { useAnalyticsFeed } from './stores/analytics';
import { useOsConnections } from './stores/osConnections';
import { BoxRestartPill } from './components/common/BoxRestartPill';
import { useReconnect } from './stores/reconnect';
import { useResume } from './hooks/useResume';
import { resumeSockets } from './lib/resumeSockets';
import { useSettings, loadSharedSettings } from './stores/settings';
import { useAgents } from './stores/agents';
import { useLedgerCard } from './stores/ledgerCard';
import { useServers } from './stores/servers';
import { useViewing } from './stores/viewing';
import { useUI } from './stores/ui';
import { bootDesktopNavigation, stopDesktopSync } from './stores/navigation';
import { readPendingIntent } from './lib/pendingIntent';
import { resyncAfterReconnect } from './lib/resync';
import { clearBadge } from './lib/badge';
import { loadBootstrap } from './lib/bootstrap';

void loadBootstrap(); // W2-H: one launch request. Here, not in the boot effect: the effects of the child components run first.

// The two shells (engineering program 2026-11-09, W2-E). Each is its own chunk: the phone never
// downloads the desktop shell, and the desktop never downloads the phone's. The import starts here,
// when this module is evaluated, and not at the first render; index.html also preloads the chunk
// for the page's width (vite.config.ts, shellPreload), so it adds no round trip after the entry.
const PHONE_MAX_WIDTH = 768; // the same limit as useIsMobile
const loadPhoneShell = () => import('./components/mobile/MobileApp').then((m) => ({ default: m.MobileApp }));
const loadDesktopShell = () => import('./components/layout/DesktopShell').then((m) => ({ default: m.DesktopShell }));
const startsOnPhone = typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX_WIDTH;
const firstShell = startsOnPhone ? loadPhoneShell() : loadDesktopShell();
const MobileApp = lazy(() => (startsOnPhone ? firstShell : loadPhoneShell()) as ReturnType<typeof loadPhoneShell>);
const DesktopShell = lazy(() => (startsOnPhone ? loadDesktopShell() : firstShell) as ReturnType<typeof loadDesktopShell>);
firstShell.catch(() => {}); // a failed fetch is reported by React.lazy at render, inside the error boundary

// Shown for the moment between the entry and the shell chunk: the canvas, with nothing on it.
const shellFallback = <div style={{ height: '100dvh', width: '100%', background: 'var(--color-canvas)' }} />;

export default function App() {
  const activeTerminalId = useTabs((s) => s.activeTabId);
  const isMobile = useIsMobile();
  useTabCycleShortcut(); // Ctrl+Tab / Ctrl+Shift+Tab cycle open tabs
  useAttentionShortcut(); // Alt+N: the next thread that needs you (W2-F)
  const sockRef = useRef<EventsSocket | null>(null);
  const hydrated = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void useProjects.getState().load();
    void useServers.getState().load();
    // The open tabs of the last visit come back first; the address is read after them (the effect below).
    hydrated.current = useTabs.getState().hydrate();
    void useAuth.getState().load();
    void useUpdate.getState().load();
    void useHost.getState().load();
    void useAgents.getState().loadSchedules();
    void useUsageLimits.getState().load();
    void useSpinnerWords.getState().load();
    void loadSharedSettings();
    // Fetch the code of the views that the first screen did not need once the app has settled, so
    // each opens without a spinner: the terminal (split out of the startup script, LazyTerminalTab),
    // the thread view (the phone starts on the list), the Control Plane and Chat (W2-E).
    // Not at once: the launch's own requests (the lists, the settings) go first on the browser's six connections.
    const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 2500));
    const laterViews = setTimeout(() => idle(() => { preloadTerminalTab(); preloadTabHost(); preloadOverseerView(); preloadChatMode(); }), 3000);
    // Keep the launch snapshot current (lib/launchSnapshot.ts): the project and thread lists, saved
    // a moment after they change so a burst of status events writes once.
    let snapTimer: ReturnType<typeof setTimeout> | undefined;
    const saveSnapshot = () => {
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => writeSnapshot({ sessions: useProjects.getState().sessions, byProject: useTabs.getState().byProject }), 1500);
    };
    const unsubSnapProjects = useProjects.subscribe((s, p) => { if (s.sessions !== p.sessions) saveSnapshot(); });
    const unsubSnapTabs = useTabs.subscribe((s, p) => { if (s.byProject !== p.byProject) saveSnapshot(); });
    // A notification tap parks its target in the SW; drain it here. This is the
    // path that actually carries the tap on iOS, where the frozen page misses the
    // postMessage entirely. Draining on every foreground (not useResume, whose 8s
    // threshold would swallow a tap made right after backgrounding) catches the
    // resume case; the call below catches a cold launch.
    const drainIntent = () => {
      void readPendingIntent().then((i) => { if (i) useUI.getState().requestOpenThread(i); });
    };
    drainIntent();
    // Opening / foregrounding the app acknowledges any pending thread alerts: clear the
    // app-icon badge the SW painted while we were away, exactly like a native app.
    void clearBadge();
    const onVisible = () => { if (!document.hidden) { drainIntent(); void clearBadge(); } };
    document.addEventListener('visibilitychange', onVisible);

    const onSwMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; sessionId?: string; terminalId?: string } | null;
      if (d?.type === 'open-thread' && d.sessionId && d.terminalId) {
        useUI.getState().requestOpenThread({ sessionId: d.sessionId, terminalId: d.terminalId });
        void readPendingIntent(); // consume the parked copy so it can't fire twice
      }
    };
    navigator.serviceWorker?.addEventListener('message', onSwMessage);
    // Detect a *re*connect (an 'open' that follows a 'closed'), not the first connect.
    // On reconnect we resync: while the socket was down we missed every terminal:status
    // broadcast, so a finished thread can be pinned at a stale 'working' in the live
    // overlay. resyncAfterReconnect drops the overlay and re-pulls the rows.
    let socketWasClosed = false;
    const sock = createEventsSocket({
      onStatus: (s) => {
        useConnection.getState().setStatus(s);
        if (s === 'closed') socketWasClosed = true;
        else if (s === 'open' && socketWasClosed) {
          socketWasClosed = false;
          void resyncAfterReconnect();
          // Endless messages broadcast while the socket was down were missed: reload the tail.
          useEndless.getState().resyncAfterReconnect();
        }
      },
      onEvent: (e) => {
        useProjects.getState().applyEvent(e);
        useTabs.getState().applyEvent(e);
        useActivity.getState().applyEvent(e);
        useThreadStatus.getState().applyEvent(e);
        useAuth.getState().applyEvent(e);
        useUpdate.getState().applyEvent(e);
        useAgents.getState().applyEvent(e);
        useAnalyticsFeed.getState().applyEvent(e);
        useLedgerCard.getState().applyEvent(e);
        useOsConnections.getState().applyEvent(e);
        useEndless.getState().applyEvent(e);
        useUsageLimits.getState().applyEvent(e);
        applyPluginEvent(e);
      },
    });
    sockRef.current = sock;
    return () => { clearTimeout(laterViews); unsubSnapProjects(); unsubSnapTabs(); clearTimeout(snapTimer); sock.close(); sockRef.current = null; document.removeEventListener('visibilitychange', onVisible); navigator.serviceWorker?.removeEventListener('message', onSwMessage); };
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
  // Deliberate limit (spec decision 3): in a multi-pane group only the ACTIVE
  // tab counts as "viewed" — a thread visible in a background pane still alerts.
  useEffect(() => {
    if (isMobile) return;
    useViewing.getState().set(activeTerminalId && !isDispatchTab(activeTerminalId) ? activeTerminalId : null);
  }, [activeTerminalId, isMobile]);

  // Desktop addresses (W2-F): after the restore of the open tabs, the address wins (a thread link
  // opens its thread and stays in the address bar), and from then on the address follows the app,
  // so Back returns to the earlier thread. The phone shell does its own (useMobileNavigation). The
  // four "pending" intents that two effects here consumed are `navigate` now (stores/navigation.ts).
  useEffect(() => {
    if (isMobile) return;
    let off = false;
    void (hydrated.current ?? Promise.resolve()).catch(() => {}).then(() => { if (!off) void bootDesktopNavigation(); });
    return () => { off = true; stopDesktopSync(); };
  }, [isMobile]);

  // Returning from the background: first ask the daemon whether the connection is still alive
  // (2026-11-05). Usually it is, and then nothing is torn down: no spinner, no "Reconnecting",
  // every view stays as it was. When the ping goes unanswered for 4 s (iOS killed the sockets while
  // the app was away), the events socket and every thread socket get a new connection. The views
  // are not remounted (W2-I): each keeps its content until its own replay arrives (lib/resumeSockets.ts).
  useResume(() => {
    const sock = sockRef.current;
    if (sock) void resumeSockets(sock, () => sockRef.current === sock);
  }, 2000);

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

  // Each shell is its own chunk, loaded for its own width only (W2-E). The Suspense sits inside the
  // boundary, so a chunk that fails to load shows the boundary's card and not a blank page.
  return (
    <>
      <SetupWizard />
      <AuthBanner />
      <BoxRestartPill />
      <UpdateModal />
      <HighScoreCelebration />
      {isMobile
        // The boundary keeps the banners and the update prompt on screen when the phone UI throws.
        ? <ErrorBoundary key="phone" scope="phone app"><Suspense fallback={shellFallback}><MobileApp /></Suspense></ErrorBoundary>
        : <ErrorBoundary key="desktop" scope="desktop app"><Suspense fallback={shellFallback}><DesktopShell /></Suspense></ErrorBoundary>}
      <HintToast />
    </>
  );
}
