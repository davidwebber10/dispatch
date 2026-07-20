import { create } from 'zustand';

// 'agents' was a dead union member (nothing read `view`) — repurposed for the desktop thread
// board (docs/superpowers/specs/2026-07-20-thread-board-design.md's "Placement" section):
// 'workspace' is the normal project/thread layout, 'board' is the full-bleed cross-project board
// that bypasses Workspace entirely (see App.tsx).
export type View = 'workspace' | 'board';
export type InspectorTab = 'details' | 'files';

const LKEY = 'dispatch:left-collapsed';
const RKEY = 'dispatch:right-collapsed';
const VKEY = 'dispatch:view';
const loadBool = (k: string): boolean => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const saveBool = (k: string, v: boolean): void => { try { localStorage.setItem(k, v ? '1' : '0'); } catch { /* ignore */ } };
const loadView = (): View => { try { return localStorage.getItem(VKEY) === 'board' ? 'board' : 'workspace'; } catch { return 'workspace'; } };
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
}>((set, get) => ({
  view: loadView(),
  setView: (view) => { saveView(view); set({ view }); },
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
}));
