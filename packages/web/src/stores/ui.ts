import { create } from 'zustand';
// A cycle with stores/navigation.ts on purpose: each side uses the other only inside a function, after both modules loaded.
import { useNavigation } from './navigation';
import { useProjects } from './projects';
import { useTabs, findTerminal } from './tabs';

// 'workspace' is the normal project/thread layout (the "Threads" view). The desktop thread board
// ('board') was removed on 2026-11-09 (W1-G); a saved 'board' value loads as 'workspace' (loadView).
// `plugin:<id>:<view>` is a plugin's screen (docs/superpowers/specs/2026-11-07-plugins-design.md).
export type View = 'workspace' | 'analytics' | 'settings' | 'chat' | `plugin:${string}`;
// `plugin:<id>:<tab>` is a plugin's right-column tab (the `inspectorTabs` contribution).
export type InspectorTab = 'details' | 'files' | `plugin:${string}`;

const LKEY = 'dispatch:left-collapsed';
const RKEY = 'dispatch:right-collapsed';
const VKEY = 'dispatch:view';
const loadBool = (k: string): boolean => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const saveBool = (k: string, v: boolean): void => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };
// Any other saved value (the removed 'board' view included) loads as 'workspace'.
const VIEWS: readonly View[] = ['workspace', 'analytics', 'settings', 'chat'];
// Exported so mount.test.tsx can exercise the read-back path directly (pre-seed
// localStorage, call this) rather than only the write path — the read-back is
// what regressed originally (the old check recognized only 'board').
export const loadView = (): View => {
  try {
    const v = localStorage.getItem(VKEY) as View | null;
    // Previews is a plugin screen now (plugins slice 4): a saved 'previews' opens it.
    if ((v as string) === 'previews') return 'plugin:previews:history';
    return v && (VIEWS.includes(v) || v.startsWith('plugin:')) ? v : 'workspace';
  } catch { return 'workspace'; }
};
const saveView = (v: View): void => { try { localStorage.setItem(VKEY, v); } catch { /* ignore */ } };

export const useUI = create<{
  view: View;
  setView: (v: View) => void;
  inspectorTab: InspectorTab;
  setInspectorTab: (t: InspectorTab) => void;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftCollapsed: (v: boolean) => void;
  setRightCollapsed: (v: boolean) => void;
  // The four "go there" intents (W2-F, 2026-11-09). Each was a pending field that a caller set and
  // an effect in the mounted shell cleared; each is a thin wrapper around `navigate` now
  // (stores/navigation.ts), kept because the plugin SDK exposes `useUI` (W3-F removes that).
  /** Open this tab (a file tab that was just made, a sign-in tab) in its project. */
  requestOpenTab: (id: string) => void;
  /** Open this thread, in whichever project it is (a notification tap, a link in Chat). */
  requestOpenThread: (v: { sessionId: string; terminalId: string }) => void;
  /** Open this project in the Threads view (the Chat pane's Docs "+N more"). */
  requestOpenProject: (id: string) => void;
  /** Open Settings at this section (the mic's "Set up" link). */
  requestSettings: (section: string) => void;
}>((set, get) => ({
  view: loadView(),
  // 'board' left the View type; an untyped caller (a plugin, an old link) that still asks for it gets Threads.
  setView: (requested) => { const view = (requested as string) === 'board' ? 'workspace' : requested; saveView(view); set({ view }); },
  inspectorTab: 'details',
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  leftCollapsed: loadBool(LKEY),
  rightCollapsed: loadBool(RKEY),
  toggleLeft: () => { const v = !get().leftCollapsed; saveBool(LKEY, v); set({ leftCollapsed: v }); },
  toggleRight: () => { const v = !get().rightCollapsed; saveBool(RKEY, v); set({ rightCollapsed: v }); },
  setLeftCollapsed: (v) => { saveBool(LKEY, v); set({ leftCollapsed: v }); },
  setRightCollapsed: (v) => { saveBool(RKEY, v); set({ rightCollapsed: v }); },
  requestOpenTab: (id) => {
    const tabs = useTabs.getState();
    const projectId = findTerminal(tabs.byProject, id)?.sessionId ?? tabs.tabSession[id] ?? useProjects.getState().activeId;
    if (projectId) useNavigation.getState().navigate({ view: 'workspace', projectId, threadId: id });
  },
  requestOpenThread: ({ sessionId, terminalId }) => useNavigation.getState().navigate({ view: 'workspace', projectId: sessionId, threadId: terminalId }),
  requestOpenProject: (id) => useNavigation.getState().navigate({ view: 'workspace', projectId: id }),
  requestSettings: (section) => useNavigation.getState().navigate({ view: 'settings', section }),
}));
