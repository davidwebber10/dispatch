// Overseer view — zustand store + live hooks.
//
// Increment 1 of the real-data wiring (see the spec). The PUBLIC surface (state
// fields + action names the components and TopBar select) is kept identical to the
// mock-era store so overseer/components/*, OverseerView, OverseerMobile and the
// TopBar ScenarioDemo all still compile — only the DATA SOURCE and the action
// implementations changed:
//   • the conversation stream is the project's coordinator thread (one structured
//     terminal, config.role='coordinator'), driven by useStructuredChat;
//   • missions/needs/outcomes are derived from the project's structured child
//     threads (config.role!=='coordinator') + their live status;
//   • directives go to the coordinator, Delegate spawns a typed worker terminal,
//     drilling a worker opens a lightbox of its structured chat View.
//
// scenario/setScenario are kept as VESTIGIAL no-ops (TopBar still references them).

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useEffect, useMemo } from 'react';
import { api, type ContentBlock } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { useStructuredChat } from '../tabs/chat/useStructuredChat';
import type { PendingPermission, Terminal } from '../../api/types';
import { CANNED, m } from './data';
import { convItemsToStream, groupByMission, isManagedWorker, mapStatus, needsFromThreads } from './live';
import type { AgentType, Ribbon, RenderVals, Scenario, StreamMessage } from './types';

export type MobileTab = 'needs' | 'stream' | 'work';

interface OverseerState {
  // ---- UI state (public surface) ----
  scenario: Scenario; // vestigial: kept only so TopBar's ScenarioDemo compiles
  drill: string | null; // vestigial: the live drill surface is the worker lightbox
  delegateOpen: boolean;
  delegateType: AgentType;
  delegateText: string;
  composer: string;
  composerImages: ContentBlock[]; // attached image blocks pending the next directive
  mobileTab: MobileTab;
  workerLightboxId: string | null; // NEW: the worker terminal whose chat View is open

  // ---- live wiring state ----
  coordinatorId: string | null; // the active project's coordinator terminal
  coordinatorProject: string | null; // the session the coordinator belongs to
  coordinatorStream: StreamMessage[]; // pushed in by useCoordinatorSync()
  coordinatorBusy: boolean; // coordinator turn in flight; pushed in by useCoordinatorSync()
  sendError: string | null; // last directive send that FAILED (POST rejected); surfaced inline, cleared on next send
  ensuring: boolean; // a find-or-create coordinator request is in flight
  resolved: string[]; // optimistically dismissed need ids
  pendingByTerminal: Record<string, PendingPermission | null>; // fetched escalations (the membrane), keyed by agent terminal id
  archivedByProject: Record<string, Terminal[]>; // archived (complete_agent'd) terminals per project; surfaced as done outcomes

  // ---- actions (public surface) ----
  setScenario: (scenario: Scenario) => void;
  drillInto: (key: string, dlabel?: string) => void;
  closeDrill: () => void;
  openDelegate: () => void;
  closeDelegate: () => void;
  pickType: (type: AgentType) => void;
  setDelegateText: (text: string) => void;
  setComposer: (text: string) => void;
  /** Buffer an attached image block to ride along with the next directive send. */
  addComposerImage: (block: ContentBlock) => void;
  sendDirective: () => void;
  needAction: (id: string, label: string) => void;
  doDelegate: () => void;
  setMobileTab: (tab: MobileTab) => void;
  goNeeds: () => void;

  // ---- new actions ----
  closeWorkerLightbox: () => void;
  ensureForProject: (sessionId: string | null) => void;
  setCoordinatorStream: (stream: StreamMessage[]) => void;
  setCoordinatorBusy: (busy: boolean) => void;
  setPending: (terminalId: string, pending: PendingPermission | null) => void;
  setArchivedTerminals: (projectId: string, terminals: Terminal[]) => void;
  /** Clean slate: archive the coordinator + its agents and start a fresh Dispatch conversation. */
  resetDispatch: () => void;
}

export const useOverseer = create<OverseerState>((set, get) => ({
  // ---- initial state ----
  scenario: 'needs',
  drill: null,
  delegateOpen: false,
  delegateType: 'implementer',
  delegateText: '',
  composer: '',
  composerImages: [],
  mobileTab: 'needs',
  workerLightboxId: null,

  coordinatorId: null,
  coordinatorProject: null,
  coordinatorStream: [],
  coordinatorBusy: false,
  sendError: null,
  ensuring: false,
  resolved: [],
  pendingByTerminal: {},
  archivedByProject: {},

  // ---- actions ----
  setScenario: (scenario) => set({ scenario }), // vestigial no-op (real state is live data)

  // Drilling a worker thread opens its structured chat View in a lightbox. The
  // thread's `key` is its terminal id (see live.terminalToAgentThread).
  drillInto: (key) => set({ workerLightboxId: key }),
  closeDrill: () => set({ drill: null }),
  closeWorkerLightbox: () => set({ workerLightboxId: null }),

  openDelegate: () => set({ delegateOpen: true }),
  closeDelegate: () => set({ delegateOpen: false, delegateText: '' }),
  pickType: (type) => set({ delegateType: type }),
  setDelegateText: (text) => set({ delegateText: text }),

  setComposer: (text) => set({ composer: text }),

  addComposerImage: (block) => set((s) => ({ composerImages: [...s.composerImages, block] })),

  sendDirective: () => {
    const text = (get().composer || '').trim();
    const images = get().composerImages;
    const id = get().coordinatorId;
    if ((!text && images.length === 0) || !id) return;
    // No optimistic bubble: the backend echoes the user's turn (and it survives
    // reconnect replay), so an optimistic append would double up. Clear any prior
    // send-failure notice — this is a fresh attempt.
    set({ composer: '', composerImages: [], sendError: null });
    // Carry any attached image blocks through as a REAL content-block turn (images first,
    // then the caption text) so the coordinator SEES the picture; a text-only directive
    // keeps the original plain-string path untouched.
    const payload: string | ContentBlock[] = images.length
      ? [...images, ...(text ? [{ type: 'text', text } as ContentBlock] : [])]
      : text;
    // Surface a failed POST instead of swallowing it: without this, a rejected send (e.g.
    // the coordinator's claude process died → 400) left ZERO feedback — the user's directive
    // (and any attached image) just vanished, reading as "nothing happened". Mirrors the
    // agent chat's visible "Failed to send message" (useStructuredChat.ts). useRenderVals
    // renders sendError as an inline error row; the next send attempt clears it.
    api.sendStructuredMessage(id, payload).catch(() => {
      if (get().coordinatorId === id) set({ sendError: 'Failed to send message' });
    });
  },

  needAction: (id, label) => {
    // The need id is the agent terminal id. When we have its fetched escalation,
    // the action is a REAL permission decision; otherwise fall back to the coarse
    // Open/ack behavior for non-permission needs_input cases.
    const pending = get().pendingByTerminal[id];
    if (pending) {
      const removeCard = () =>
        set((s) => ({ resolved: [...s.resolved, id], pendingByTerminal: { ...s.pendingByTerminal, [id]: null } }));
      if (/^deny$/i.test(label)) {
        api.answerPermission(id, { requestId: pending.requestId, decision: 'deny' }).catch(() => {});
      } else if (pending.questions?.[0]) {
        // An AskUserQuestion option: answer maps the question text → the chosen label.
        const question = pending.questions[0].question;
        api.answerPermission(id, { requestId: pending.requestId, decision: 'allow', answers: { [question]: label } }).catch(() => {});
      } else {
        // A plain gated tool: Approve.
        api.answerPermission(id, { requestId: pending.requestId, decision: 'allow' }).catch(() => {});
      }
      removeCard(); // optimistic
      return;
    }
    // Coarse fallback (non-permission needs_input): Open → lightbox, else ack coordinator.
    if (/open/i.test(label)) {
      set({ workerLightboxId: id });
      return;
    }
    const { coordinatorId } = get();
    if (coordinatorId) api.sendStructuredMessage(coordinatorId, CANNED.needAck(label)).catch(() => {});
    set((s) => ({ resolved: [...s.resolved, id] }));
  },

  doDelegate: () => {
    const { delegateType, delegateText, coordinatorProject } = get();
    const sessionId = coordinatorProject ?? useProjects.getState().activeId;
    set({ delegateOpen: false, delegateText: '' });
    if (!sessionId) return;
    const mission = (delegateText || '').trim() || 'New task';
    api
      .createTerminal(sessionId, {
        type: 'claude-code',
        config: { transport: 'structured', agentType: delegateType, mission },
      })
      .then(() => useTabs.getState().loadTabs(sessionId))
      .catch(() => { /* ignore; the next refetch reconciles */ });
  },

  setMobileTab: (tab) => set({ mobileTab: tab }),

  // On desktop the needs zone is already visible (no-op visually); on mobile this
  // jumps to the Needs tab. Setting mobileTab on desktop is harmless.
  goNeeds: () => set({ mobileTab: 'needs' }),

  ensureForProject: (sessionId) => {
    if (!sessionId) return;
    const st = get();
    if (st.coordinatorProject === sessionId && (st.coordinatorId || st.ensuring)) return;
    // Switching projects: reset the coordinator + derived view, then find-or-create.
    set({
      coordinatorProject: sessionId,
      coordinatorId: null,
      coordinatorStream: [],
      coordinatorBusy: false,
      sendError: null,
      resolved: [],
      pendingByTerminal: {},
      ensuring: true,
    });
    // Refresh the project's threads so managed workers show even before the shell loads them.
    void useTabs.getState().loadTabs(sessionId).catch(() => {});
    api
      .ensureOverseerCoordinator(sessionId)
      .then(({ terminalId }) => {
        if (get().coordinatorProject !== sessionId) return; // project switched mid-flight
        set({ coordinatorId: terminalId, ensuring: false });
      })
      .catch(() => {
        if (get().coordinatorProject === sessionId) set({ ensuring: false });
      });
  },

  setCoordinatorStream: (stream) => set({ coordinatorStream: stream }),

  setCoordinatorBusy: (busy) => set({ coordinatorBusy: busy }),

  setPending: (terminalId, pending) =>
    set((s) => ({ pendingByTerminal: { ...s.pendingByTerminal, [terminalId]: pending } })),

  setArchivedTerminals: (projectId, terminals) =>
    set((s) => ({ archivedByProject: { ...s.archivedByProject, [projectId]: terminals } })),

  resetDispatch: () => {
    const sessionId = get().coordinatorProject;
    if (!sessionId) return;
    const old = get().coordinatorId;
    // Clear the view immediately so the chat reads as a clean slate while we work.
    set({ coordinatorId: null, coordinatorStream: [], coordinatorBusy: false, sendError: null, resolved: [], pendingByTerminal: {}, composer: '', composerImages: [], ensuring: true });
    void (async () => {
      try {
        // Archive the old coordinator + all its managed agents (full clean slate).
        const terminals = await api.listTerminals(sessionId).catch(() => [] as unknown[]);
        const ids = new Set<string>();
        for (const t of terminals as any[]) {
          const role = t?.config?.role;
          if (role === 'coordinator' || role === 'agent') ids.add(t.id);
        }
        if (old) ids.add(old);
        await Promise.all([...ids].map((id) => api.archiveTerminal(id).catch(() => {})));
        await useTabs.getState().loadTabs(sessionId).catch(() => {}); // clear the rail
        // Find-or-create → a brand-new coordinator (the old one is archived now).
        const { terminalId } = await api.ensureOverseerCoordinator(sessionId);
        if (get().coordinatorProject === sessionId) set({ coordinatorId: terminalId, ensuring: false });
      } catch {
        if (get().coordinatorProject === sessionId) set({ ensuring: false });
      }
    })();
  },
}));

// ---------------------------------------------------------------------------
// Active-project persistence — survive a page refresh.
//
// The active project id is OWNED by useProjects (stores/projects.ts): on refresh
// that store re-initializes with activeId=null and its load() falls back to
// `get().activeId ?? sessions[0]?.id` — i.e. the FIRST server-ordered project —
// so the user's selection is lost. We can't edit projects.ts from here, so we
// persist/restore from this module (the overseer drives project selection via
// ensureForProject). Key mirrors the codebase's `dispatch:` convention.
const ACTIVE_PROJECT_KEY = 'dispatch:overseer:activeProject';

function readStoredActiveProject(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null; // storage unavailable (private mode / SSR) — no persisted value
  }
}

function writeStoredActiveProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
    else localStorage.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    /* storage unavailable — best-effort persistence, never throw into a store write */
  }
}

// Captured ONCE, before the first useProjects write can clobber localStorage: on
// load, useProjects auto-selects sessions[0] and our subscribe below would persist
// that over the top of the real last selection. Reading here freezes the true value.
const storedActiveProject = readStoredActiveProject();
let activeProjectRestored = false;

// One-shot restore: as soon as the project list is available, re-select the stored
// project IFF it still exists; otherwise leave the existing default in place. Gated
// so the user owns the selection after the first (async) list load.
function restoreActiveProject(sessions: readonly { id: string }[], activeId: string | null): void {
  if (activeProjectRestored || sessions.length === 0) return;
  activeProjectRestored = true;
  if (
    storedActiveProject &&
    storedActiveProject !== activeId &&
    sessions.some((s) => s.id === storedActiveProject)
  ) {
    useProjects.getState().setActive(storedActiveProject);
  }
}

// Persist every switch, and run the one-shot restore once the list loads (projects
// load async, after this module evaluates, so restore rides in on the subscribe).
useProjects.subscribe((state, prev) => {
  if (state.activeId !== prev.activeId) writeStoredActiveProject(state.activeId);
  restoreActiveProject(state.sessions, state.activeId);
});
// Cover the race where projects were ALREADY loaded before this module evaluated —
// subscribe only fires on future changes, so try an immediate restore too (no-ops
// while the list is still empty, leaving the subscribe path to handle it later).
{
  const s = useProjects.getState();
  restoreActiveProject(s.sessions, s.activeId);
}

/**
 * Single owner of the live coordinator subscription. Call this ONCE from the
 * Overseer root (OverseerView) — it ensures the coordinator for the active project
 * and drives exactly one structured websocket, pushing the converted stream into
 * the store so useRenderVals() (used by many components) can stay a pure store read
 * and not open a socket per consumer.
 */
export function useCoordinatorSync(): void {
  const activeId = useProjects((s) => s.activeId);
  const ensureForProject = useOverseer((s) => s.ensureForProject);
  const coordinatorId = useOverseer((s) => s.coordinatorId);
  const coordinatorProject = useOverseer((s) => s.coordinatorProject);
  const setCoordinatorStream = useOverseer((s) => s.setCoordinatorStream);
  const setCoordinatorBusy = useOverseer((s) => s.setCoordinatorBusy);

  useEffect(() => {
    ensureForProject(activeId);
  }, [activeId, ensureForProject]);

  // Pass the coordinator's project as the sessionId (matching the agent ChatView) so
  // PATH-form image blocks resolve via the sandboxed byte route instead of being dropped
  // — without it, imageItemFromBlock returns null for path refs and images vanish after a
  // daemon-restart/transcript-resume. (The hook reads sessionId via a ref, so this does
  // NOT re-key the socket effect.)
  const { items, busy } = useStructuredChat(coordinatorId ?? '', coordinatorProject ?? undefined);
  const stream = useMemo(() => convItemsToStream(items), [items]);
  useEffect(() => {
    setCoordinatorStream(stream);
  }, [stream, setCoordinatorStream]);
  useEffect(() => {
    setCoordinatorBusy(busy);
  }, [busy, setCoordinatorBusy]);

  // Keep the project's archived (complete_agent'd) workers in the store so the rail can
  // render them as done outcomes. Folded in here (the single root-mounted sync) to avoid
  // touching the Overseer root component.
  useArchivedSync(activeId);
}

/**
 * Fetch + maintain the project's ARCHIVED structured terminals (the live list excludes
 * archived_at, so completed agents are invisible without this). Refetches when the project
 * changes OR when the live worker set changes — an agent completing drops out of the live
 * list (that change re-triggers), so it gets picked up in the archived list right after.
 */
function useArchivedSync(activeId: string | null): void {
  const byProject = useTabs((s) => s.byProject);
  const setArchivedTerminals = useOverseer((s) => s.setArchivedTerminals);

  // Signature of the live managed-worker ids: changes when an agent is archived (drops out).
  const liveSig = useMemo(() => {
    const terminals = (activeId && byProject[activeId]) || [];
    return terminals.filter(isManagedWorker).map((t) => t.id).join(',');
  }, [activeId, byProject]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    api
      .listArchivedTerminals(activeId)
      .then((list) => { if (!cancelled) setArchivedTerminals(activeId, list); })
      .catch(() => { /* best-effort: the live rail still renders without archived outcomes */ });
    return () => { cancelled = true; };
  }, [activeId, liveSig, setArchivedTerminals]);
}

/**
 * Fetch + maintain the REAL escalations (the membrane) for the active project. For
 * each agent thread currently blocked (needs_input) we fetch its pending gated tool /
 * AskUserQuestion once and stash it so useRenderVals() can build a rich approve/deny/
 * answer Need. When a thread stops being blocked we drop its entry (and any optimistic
 * resolve) so a later re-escalation re-fetches fresh. Call ONCE from the Overseer root.
 */
export function useNeedsSync(): void {
  const activeId = useProjects((s) => s.activeId);
  const byProject = useTabs((s) => s.byProject);
  const byTerminal = useThreadStatus((s) => s.byTerminal);
  const setPending = useOverseer((s) => s.setPending);

  const waitingKey = useMemo(() => {
    const terminals = (activeId && byProject[activeId]) || [];
    return terminals
      .filter(isManagedWorker)
      .filter((t) => mapStatus(t, byTerminal[t.id]) === 'waiting')
      .map((t) => t.id)
      .join(',');
  }, [activeId, byProject, byTerminal]);

  useEffect(() => {
    const ids = waitingKey ? waitingKey.split(',') : [];
    const known = useOverseer.getState().pendingByTerminal;
    // Fetch escalations we haven't fetched yet (undefined = unknown; null = resolved/none).
    for (const id of ids) {
      if (known[id] === undefined) {
        api.getPermission(id)
          .then((p) => setPending(id, p))
          .catch(() => { /* surfaced as the coarse fallback card */ });
      }
    }
    // Drop entries for threads no longer blocked → a re-escalation re-fetches fresh.
    const stale = Object.keys(known).filter((id) => !ids.includes(id));
    if (stale.length) {
      useOverseer.setState((s) => {
        const next = { ...s.pendingByTerminal };
        for (const id of stale) delete next[id];
        return { pendingByTerminal: next, resolved: s.resolved.filter((r) => !stale.includes(r)) };
      });
    }
  }, [waitingKey, setPending]);
}

// Derived view model. Pure read over the live stores (no websocket here — that's
// owned by useCoordinatorSync), memoized so the snapshot reference is stable.
export function useRenderVals(): RenderVals {
  const { coordinatorId, coordinatorStream, coordinatorBusy, sendError, resolved, pendingByTerminal, archivedByProject } = useOverseer(
    useShallow((s) => ({
      coordinatorId: s.coordinatorId,
      coordinatorStream: s.coordinatorStream,
      coordinatorBusy: s.coordinatorBusy,
      sendError: s.sendError,
      resolved: s.resolved,
      pendingByTerminal: s.pendingByTerminal,
      archivedByProject: s.archivedByProject,
    })),
  );
  const activeId = useProjects((s) => s.activeId);
  const byProject = useTabs((s) => s.byProject);
  const byTerminal = useThreadStatus((s) => s.byTerminal);

  return useMemo(() => {
    const terminals = (activeId && byProject[activeId]) || [];
    const archived = (activeId && archivedByProject[activeId]) || [];
    const missions = groupByMission(terminals, byTerminal, archived);
    const needs = needsFromThreads(terminals, byTerminal, pendingByTerminal).filter((n) => !resolved.includes(n.id));

    let working = 0;
    let done = 0;
    for (const mi of missions) {
      for (const t of mi.threads) if (t.isWorking) working++;
      done += mi.outcomes.length;
    }

    const hasNeeds = needs.length > 0;
    const noMissions = missions.length === 0;
    const hasCoordinator = !!coordinatorId;
    const emptyMode = !hasCoordinator || (noMissions && coordinatorStream.length === 0);

    // First-run / empty conversation → the Overseer greeting.
    const base: StreamMessage[] = coordinatorStream.length
      ? coordinatorStream
      : [m('overseer', 'Dispatch', CANNED.emptyGreeting, '', 'greeting')];
    // Append a transient send-failure notice (BUG 1: previously swallowed) so a rejected
    // directive is VISIBLE inline; cleared by the next send attempt / project switch.
    const stream: StreamMessage[] = sendError
      ? [...base, { kind: 'note', who: null, text: sendError, time: '', key: 'send-error', isUser: false, isOverseer: false, isNote: false, isError: true }]
      : base;

    const ribbon: Ribbon = { working, done, needs: needs.length, hasNeeds };

    return {
      ribbon,
      needs,
      missions,
      stream,
      busy: coordinatorBusy,
      drillDetail: null, // the live drill surface is the worker lightbox, not the rail
      hasNeeds,
      noMissions,
      emptyMode,
      drillOpen: false,
      overviewOpen: true,
    };
  }, [coordinatorId, coordinatorStream, coordinatorBusy, sendError, resolved, pendingByTerminal, archivedByProject, activeId, byProject, byTerminal]);
}
