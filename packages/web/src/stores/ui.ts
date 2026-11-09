import { create } from 'zustand';

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
  // Cross-shell "navigate to this tab" intent (e.g. View's "open file" button).
  // Desktop navigates via tabs.openTab directly; mobile consumes this to run its
  // own leaf navigation (openThread). Set, then cleared by the consumer.
  pendingOpenTab: string | null;
  requestOpenTab: (id: string) => void;
  clearOpenTab: () => void;
  // Cross-shell "open this thread (possibly in another project)" intent — set by
  // the SW notification tap / deep-link boot, consumed by whichever shell is live.
  pendingOpenThread: { sessionId: string; terminalId: string } | null;
  requestOpenThread: (v: { sessionId: string; terminalId: string }) => void;
  clearOpenThread: () => void;
  // Cross-shell "open this project in the Threads view" intent (the Chat pane's Docs "+N more").
  pendingOpenProject: string | null;
  requestOpenProject: (id: string) => void;
  clearOpenProject: () => void;
  /** Cross-shell "open Settings at this section" intent (the mic's "Set up" link). */
  pendingSettingsSection: string | null;
  requestSettings: (section: string) => void;
  clearSettingsRequest: () => void;
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
  pendingOpenTab: null,
  requestOpenTab: (id) => set({ pendingOpenTab: id }),
  clearOpenTab: () => set({ pendingOpenTab: null }),
  pendingOpenThread: null,
  requestOpenThread: (v) => set({ pendingOpenThread: v }),
  clearOpenThread: () => set({ pendingOpenThread: null }),
  pendingOpenProject: null,
  requestOpenProject: (id) => set({ pendingOpenProject: id }),
  clearOpenProject: () => set({ pendingOpenProject: null }),
  pendingSettingsSection: null,
  requestSettings: (section) => { saveView('settings'); set({ view: 'settings', pendingSettingsSection: section }); },
  clearSettingsRequest: () => set({ pendingSettingsSection: null }),
}));
