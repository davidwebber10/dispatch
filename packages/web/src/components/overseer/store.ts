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
import { api } from '../../api/client';
import { useProjects } from '../../stores/projects';
import { useTabs } from '../../stores/tabs';
import { useThreadStatus } from '../../stores/threadStatus';
import { useStructuredChat } from '../tabs/chat/useStructuredChat';
import { CANNED, m } from './data';
import { convItemsToStream, groupByMission, needsFromThreads } from './live';
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
  mobileTab: MobileTab;
  workerLightboxId: string | null; // NEW: the worker terminal whose chat View is open

  // ---- live wiring state ----
  coordinatorId: string | null; // the active project's coordinator terminal
  coordinatorProject: string | null; // the session the coordinator belongs to
  coordinatorStream: StreamMessage[]; // pushed in by useCoordinatorSync()
  ensuring: boolean; // a find-or-create coordinator request is in flight
  resolved: string[]; // optimistically dismissed need ids

  // ---- actions (public surface) ----
  setScenario: (scenario: Scenario) => void;
  drillInto: (key: string, dlabel?: string) => void;
  closeDrill: () => void;
  openDelegate: () => void;
  closeDelegate: () => void;
  pickType: (type: AgentType) => void;
  setDelegateText: (text: string) => void;
  setComposer: (text: string) => void;
  sendDirective: () => void;
  needAction: (id: string, label: string) => void;
  doDelegate: () => void;
  setMobileTab: (tab: MobileTab) => void;
  goNeeds: () => void;

  // ---- new actions ----
  closeWorkerLightbox: () => void;
  ensureForProject: (sessionId: string | null) => void;
  setCoordinatorStream: (stream: StreamMessage[]) => void;
}

export const useOverseer = create<OverseerState>((set, get) => ({
  // ---- initial state ----
  scenario: 'needs',
  drill: null,
  delegateOpen: false,
  delegateType: 'implementer',
  delegateText: '',
  composer: '',
  mobileTab: 'needs',
  workerLightboxId: null,

  coordinatorId: null,
  coordinatorProject: null,
  coordinatorStream: [],
  ensuring: false,
  resolved: [],

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

  sendDirective: () => {
    const text = (get().composer || '').trim();
    const id = get().coordinatorId;
    if (!text || !id) return;
    // No optimistic bubble: the backend echoes the user's turn (and it survives
    // reconnect replay), so an optimistic append would double up.
    set({ composer: '' });
    api.sendStructuredMessage(id, text).catch(() => { /* surfaced in the stream */ });
  },

  needAction: (id, label) => {
    // Increment 1 is coarse. The need id is the worker terminal id.
    //   "Open" → pop the worker lightbox so the user can monitor/interject.
    //   anything else → ack the coordinator (real approve/deny/answer = incr. 3).
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
      resolved: [],
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

  useEffect(() => {
    ensureForProject(activeId);
  }, [activeId, ensureForProject]);

  const { items } = useStructuredChat(coordinatorId ?? '');
  const stream = useMemo(() => convItemsToStream(items), [items]);
  useEffect(() => {
    setCoordinatorStream(stream);
  }, [stream, setCoordinatorStream]);
}

// Derived view model. Pure read over the live stores (no websocket here — that's
// owned by useCoordinatorSync), memoized so the snapshot reference is stable.
export function useRenderVals(): RenderVals {
  const { coordinatorId, coordinatorStream, resolved } = useOverseer(
    useShallow((s) => ({
      coordinatorId: s.coordinatorId,
      coordinatorStream: s.coordinatorStream,
      resolved: s.resolved,
    })),
  );
  const activeId = useProjects((s) => s.activeId);
  const byProject = useTabs((s) => s.byProject);
  const byTerminal = useThreadStatus((s) => s.byTerminal);

  return useMemo(() => {
    const terminals = (activeId && byProject[activeId]) || [];
    const missions = groupByMission(terminals, byTerminal);
    const needs = needsFromThreads(terminals, byTerminal).filter((n) => !resolved.includes(n.id));

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
      : [m('overseer', 'Overseer', CANNED.emptyGreeting, '', 'greeting')];

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
      drillDetail: null, // the live drill surface is the worker lightbox, not the rail
      hasNeeds,
      noMissions,
      emptyMode,
      drillOpen: false,
      overviewOpen: true,
    };
  }, [coordinatorId, coordinatorStream, resolved, activeId, byProject, byTerminal]);
}
