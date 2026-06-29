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
import type { PendingPermission } from '../../api/types';
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
  ensuring: boolean; // a find-or-create coordinator request is in flight
  resolved: string[]; // optimistically dismissed need ids
  pendingByTerminal: Record<string, PendingPermission | null>; // fetched escalations (the membrane), keyed by agent terminal id

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
  ensuring: false,
  resolved: [],
  pendingByTerminal: {},

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
    // reconnect replay), so an optimistic append would double up.
    set({ composer: '', composerImages: [] });
    // Carry any attached image blocks through as a REAL content-block turn (images first,
    // then the caption text) so the coordinator SEES the picture; a text-only directive
    // keeps the original plain-string path untouched.
    const payload: string | ContentBlock[] = images.length
      ? [...images, ...(text ? [{ type: 'text', text } as ContentBlock] : [])]
      : text;
    api.sendStructuredMessage(id, payload).catch(() => { /* surfaced in the stream */ });
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

  resetDispatch: () => {
    const sessionId = get().coordinatorProject;
    if (!sessionId) return;
    const old = get().coordinatorId;
    // Clear the view immediately so the chat reads as a clean slate while we work.
    set({ coordinatorId: null, coordinatorStream: [], coordinatorBusy: false, resolved: [], pendingByTerminal: {}, composer: '', composerImages: [], ensuring: true });
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
  const setCoordinatorStream = useOverseer((s) => s.setCoordinatorStream);
  const setCoordinatorBusy = useOverseer((s) => s.setCoordinatorBusy);

  useEffect(() => {
    ensureForProject(activeId);
  }, [activeId, ensureForProject]);

  const { items, busy } = useStructuredChat(coordinatorId ?? '');
  const stream = useMemo(() => convItemsToStream(items), [items]);
  useEffect(() => {
    setCoordinatorStream(stream);
  }, [stream, setCoordinatorStream]);
  useEffect(() => {
    setCoordinatorBusy(busy);
  }, [busy, setCoordinatorBusy]);
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
  const { coordinatorId, coordinatorStream, coordinatorBusy, resolved, pendingByTerminal } = useOverseer(
    useShallow((s) => ({
      coordinatorId: s.coordinatorId,
      coordinatorStream: s.coordinatorStream,
      coordinatorBusy: s.coordinatorBusy,
      resolved: s.resolved,
      pendingByTerminal: s.pendingByTerminal,
    })),
  );
  const activeId = useProjects((s) => s.activeId);
  const byProject = useTabs((s) => s.byProject);
  const byTerminal = useThreadStatus((s) => s.byTerminal);

  return useMemo(() => {
    const terminals = (activeId && byProject[activeId]) || [];
    const missions = groupByMission(terminals, byTerminal);
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
    const stream: StreamMessage[] = coordinatorStream.length
      ? coordinatorStream
      : [m('overseer', 'Dispatch', CANNED.emptyGreeting, '', 'greeting')];

    const moodText = hasNeeds
      ? `${needs.length} ${needs.length === 1 ? 'thing needs you' : 'things need you'}`
      : noMissions
        ? 'Ready when you are'
        : 'Calm — nothing needs you';

    const ribbon: Ribbon = { working, done, needs: needs.length, hasNeeds, moodText };

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
  }, [coordinatorId, coordinatorStream, coordinatorBusy, resolved, pendingByTerminal, activeId, byProject, byTerminal]);
}
